/**
 * 本地 HTTP 代理：ZCode 自定义提供商 → GitHub Copilot API。
 *
 * 路由映射（入站 → 上游）：
 *   POST /v1/messages       → {copilot}/v1/messages        (anthropic-messages, Claude)
 *   POST /v1/chat/completions → {copilot}/chat/completions (openai-chat-completions)
 *   POST /v1/responses      → {copilot}/responses          (openai-responses, GPT/Grok)
 *   GET  /v1/models         → {copilot}/models
 *   GET  /health            → 本地健康检查（含登录态）
 *
 * 职责：令牌注入与自动刷新、Copilot 必需身份头、动态头（X-Initiator /
 * Openai-Intent / Copilot-Vision-Request）、chat/completions 兼容性清洗，
 * SSE 流按需改写（responses 的 item_id 归一、chat 的 reasoning_text 改名）。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, appendFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable, Transform } from "node:stream";
import { COPILOT_STATIC_HEADERS, copilotBaseUrl } from "./copilot/constants.ts";
import { credentialStatus, ensureFreshCredential, NotLoggedInError } from "./token-manager.ts";
import { daemonLogPath, pluginDataDir } from "./store.ts";

const MAX_BODY_BYTES = 256 * 1024 * 1024;

/** 每个上游请求记录一行摘要；失败响应追加错误体片段，便于定位 ZCode 侧真实失败。 */
async function proxyLog(line: string): Promise<void> {
  try {
    const target = daemonLogPath();
    await mkdir(dirname(target), { recursive: true });
    await appendFile(target, `[${new Date().toISOString()}] ${line}\n`, "utf-8");
  } catch {
    // 日志失败不影响转发。
  }
}

/** ZCODE_COPILOT_DEBUG=1 时把完整请求体落到 ~/.zcode-copilot/dumps/ 供离线排查。 */
async function dumpRequest(kind: string, model: string, body: Buffer): Promise<void> {
  if (process.env.ZCODE_COPILOT_DEBUG !== "1") return;
  try {
    const dir = `${pluginDataDir()}/dumps`;
    await mkdir(dir, { recursive: true });
    await writeFile(`${dir}/${Date.now()}-${kind}-${model}.json`, body, "utf-8");
  } catch {
    // 转储失败不影响转发。
  }
}

interface UpstreamRoute {
  upstreamPath: string;
  kind: "messages" | "chat" | "responses" | "models";
}

function route(method: string, rawPath: string): UpstreamRoute | null {
  const path = rawPath.replace(/\/+$/, "") || "/";
  if (method === "GET" && (path === "/v1/models" || path === "/models")) {
    return { upstreamPath: "/models", kind: "models" };
  }
  if (method === "POST") {
    if (path === "/v1/messages" || path === "/messages") {
      return { upstreamPath: "/v1/messages", kind: "messages" };
    }
    if (path === "/v1/chat/completions" || path === "/chat/completions") {
      return { upstreamPath: "/chat/completions", kind: "chat" };
    }
    if (path === "/v1/responses" || path === "/responses") {
      return { upstreamPath: "/responses", kind: "responses" };
    }
  }
  return null;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY_BYTES) throw new Error("Request body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function errorPayload(message: string): { error: { message: string; type: string } } {
  return { error: { message, type: "zcode_copilot_proxy_error" } };
}

/** 解析后的请求体分析结果，用于构造动态头与清洗。 */
interface BodyAnalysis {
  lastRole?: string;
  hasImage: boolean;
}

function analyzeBody(parsed: unknown): BodyAnalysis {
  const result: BodyAnalysis = { hasImage: false };
  if (!parsed || typeof parsed !== "object") return result;
  const messages = (parsed as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return result;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: unknown; content?: unknown } | null;
    if (!message || typeof message !== "object") continue;
    if (result.lastRole === undefined && typeof message.role === "string") {
      result.lastRole = message.role;
    }
    const content = message.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        const type = (part as { type?: unknown } | null)?.type;
        if (type === "image_url" || type === "image" || type === "input_image" || type === "source") {
          result.hasImage = true;
        }
      }
    }
  }
  return result;
}

/**
 * messages（Claude）兼容性清洗：
 * GitHub Copilot 的 Claude 5.x 已不支持 `thinking: {type: "enabled", budget_tokens}`，
 * 会返回 invalid_request_error 并要求改用 `thinking: {type: "adaptive"}` +
 * `output_config.effort`。这里把 ZCode 等客户端发来的 enabled 形态降级为
 * adaptive（budget_tokens 无对应映射，直接丢弃），新旧 Claude 模型均接受。
 */
function sanitizeMessagesBody(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== "object") return parsed;
  const body = { ...(parsed as Record<string, unknown>) };
  const thinking = body.thinking as { type?: unknown } | undefined;
  if (thinking && typeof thinking === "object" && thinking.type === "enabled") {
    body.thinking = { type: "adaptive" };
  }
  // [2026-11-06]-[GitHub Copilot 的 anthropic 端点拒收 messages 里的 role:'system'（要求用顶层 system 字段），zcode.z.ai 容忍该形态，问题只在 copilot lane 暴露为 400 invalid_request]-[转发前把 system 角色消息折叠进顶层 system，claude 系模型在 ZCode 中才可用]
  if (Array.isArray(body.messages)) {
    const systemParts: string[] = [];
    const existing = body.system;
    if (typeof existing === "string" && existing.trim()) {
      systemParts.push(existing);
    } else if (Array.isArray(existing)) {
      for (const block of existing) {
        const text = (block as { text?: unknown } | null)?.text;
        if (typeof text === "string" && text.trim()) systemParts.push(text);
      }
    }
    const kept: unknown[] = [];
    for (const message of body.messages) {
      if (
        message &&
        typeof message === "object" &&
        (message as { role?: unknown }).role === "system"
      ) {
        const content = (message as { content?: unknown }).content;
        let text = "";
        if (typeof content === "string") {
          text = content;
        } else if (Array.isArray(content)) {
          text = content
            .filter(
              (b): b is { type: "text"; text: string } =>
                !!b &&
                typeof b === "object" &&
                (b as { type?: unknown }).type === "text" &&
                typeof (b as { text?: unknown }).text === "string",
            )
            .map((b) => b.text)
            .join("\n\n");
        }
        if (text.trim()) systemParts.push(text);
        continue;
      }
      kept.push(message);
    }
    if (systemParts.length > 0) {
      body.system = systemParts.join("\n\n");
      body.messages = kept;
    }
  }
  // [2026-11-06]-[跨模型回放时 thinking 块缺 signature 或签名不属当前模型，GitHub 严格校验直接 400]-[剥离历史中全部 thinking/redacted_thinking 块（签名跨模型一律失效，只剥无签名的堵不住 claude↔claude 混切），glm/gpt/claude 混用会话在 claude lane 可用]
  if (Array.isArray(body.messages)) {
    const cleaned: unknown[] = [];
    for (const message of body.messages) {
      const m = message as { role?: unknown; content?: unknown } | null;
      if (
        m &&
        typeof m === "object" &&
        m.role === "assistant" &&
        Array.isArray(m.content)
      ) {
        const blocks = (m.content as unknown[]).filter((b) => {
          if (!b || typeof b !== "object") return true;
          const t = (b as { type?: unknown }).type;
          return t !== "thinking" && t !== "redacted_thinking";
        });
        if (blocks.length === 0) continue;
        if (blocks.length !== (m.content as unknown[]).length) {
          cleaned.push({ ...(m as Record<string, unknown>), content: blocks });
          continue;
        }
      }
      cleaned.push(message);
    }
    body.messages = cleaned;
  }
  return body;
}

/**
 * chat/completions 兼容性清洗（对齐 pi 的 compat 标志）：
 * - 移除 store（不支持）
 * - developer 角色 → system（不支持 developer）
 * reasoning_effort 保留透传：gemini / kimi 等模型在 /models 中声明了
 * reasoning_effort 档位，ZCode 只会为这些模型生成该参数。
 */
function sanitizeChatCompletionsBody(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== "object") return parsed;
  const body = { ...(parsed as Record<string, unknown>) };
  delete body.store;
  if (Array.isArray(body.messages)) {
    body.messages = body.messages.map((message) => {
      if (message && typeof message === "object" && (message as { role?: unknown }).role === "developer") {
        return { ...message, role: "system" };
      }
      return message;
    });
  }
  return body;
}

/**
 * Copilot responses SSE 的缺陷：同一 output item 的各事件（output_text.delta、
 * content_part.added、reasoning_summary_part.added、output_item.done 等）携带的
 * item_id / item.id 彼此不同、也与 `response.output_item.added` 注册的不一致
 * （实测 gpt-6-luna 同一 message 的 5 个事件用了 5 个不同 id）。
 * @ai-sdk/openai 按 item_id 关联流事件，查表 miss 时报 "text part …" /
 * 读 undefined.summaryParts，ZCode 表现为 turn failed。
 * 所有事件都带稳定的 output_index，这里以它为锚，把每个事件的 id
 * 归一为该 output_index 在 output_item.added 时注册的 item id。
 */
function createResponsesItemRewriter(): Transform {
  const indexToId = new Map<number, string>();
  let buffer = "";
  const rewriteLine = (line: string): string => {
    if (!line.startsWith("data: ")) return line;
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(line.slice(6)) as Record<string, unknown>;
    } catch {
      return line;
    }
    const type = json.type;
    if (typeof type !== "string") return line;
    const outputIndex = json.output_index;
    if (type === "response.output_item.added") {
      const item = json.item as { id?: unknown } | undefined;
      if (typeof outputIndex === "number" && item && typeof item.id === "string") {
        indexToId.set(outputIndex, item.id);
      }
      return line;
    }
    if (typeof outputIndex !== "number") return line;
    const canonical = indexToId.get(outputIndex);
    if (canonical === undefined) return line;
    let changed = false;
    if (typeof json.item_id === "string" && json.item_id !== canonical) {
      json.item_id = canonical;
      changed = true;
    }
    if (type === "response.output_item.done") {
      const item = json.item as { id?: unknown } | undefined;
      if (item && typeof item.id === "string" && item.id !== canonical) {
        item.id = canonical;
        changed = true;
      }
    }
    return changed ? `data: ${JSON.stringify(json)}` : line;
  };
  return new Transform({
    transform(chunk: Buffer, _encoding: string, callback: (error?: Error | null, data?: string) => void) {
      try {
        buffer += chunk.toString("utf-8");
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        callback(null, lines.map(rewriteLine).join("\n") + (lines.length ? "\n" : ""));
      } catch {
        // 改写失败时宁可透传原始数据。
        callback(null, chunk.toString("utf-8"));
      }
    },
    flush(callback: (error?: Error | null, data?: string) => void) {
      if (buffer) callback(null, rewriteLine(buffer));
      else callback();
    },
  });
}

/**
 * chat/completions 思考链改写：Copilot 对 kimi / gemini-3.8-flash 下发非标准的
 * delta.reasoning_text（gemini-4-argon 仅 reasoning_opaque，无可读思考文本），
 * 而 ZCode 的 openai-compatible 客户端只认 DeepSeek 风格的 reasoning_content，
 * 不改写时这两个家族在 ZCode 中没有思考链可渲染。逐 SSE 行重命名该字段，
 * reasoning_opaque 等其余字段原样保留（无状态续轮可能需要回传）。
 */
function createChatReasoningRewriter(): Transform {
  let buffer = "";
  const rewriteLine = (line: string): string => {
    if (!line.startsWith("data: ") || line.startsWith("data: [DONE]")) return line;
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(line.slice(6)) as Record<string, unknown>;
    } catch {
      return line;
    }
    const choices = json.choices;
    if (!Array.isArray(choices)) return line;
    let changed = false;
    for (const choice of choices) {
      const delta = (choice as { delta?: unknown } | null)?.delta;
      if (!delta || typeof delta !== "object") continue;
      const record = delta as Record<string, unknown>;
      if (typeof record.reasoning_text === "string" && record.reasoning_content === undefined) {
        record.reasoning_content = record.reasoning_text;
        delete record.reasoning_text;
        changed = true;
      }
    }
    return changed ? `data: ${JSON.stringify(json)}` : line;
  };
  return new Transform({
    transform(chunk: Buffer, _encoding: string, callback: (error?: Error | null, data?: string) => void) {
      try {
        buffer += chunk.toString("utf-8");
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        callback(null, lines.map(rewriteLine).join("\n") + (lines.length ? "\n" : ""));
      } catch {
        // 改写失败时宁可透传原始数据。
        callback(null, chunk.toString("utf-8"));
      }
    },
    flush(callback: (error?: Error | null, data?: string) => void) {
      if (buffer) callback(null, rewriteLine(buffer));
      else callback();
    },
  });
}

export function createProxyServer(): Server {
  return createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.destroy(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof NotLoggedInError) {
        sendJson(res, 503, errorPayload(message));
      } else {
        sendJson(res, 502, errorPayload(`Copilot proxy request failed: ${message}`));
      }
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === "GET" && (req.url === "/health" || req.url === "/")) {
    const status = await credentialStatus();
    sendJson(res, 200, { ok: true, service: "zcode-copilot", ...status });
    return;
  }

  const routeInfo = route(req.method ?? "GET", req.url ?? "/");
  if (!routeInfo) {
    sendJson(res, 404, errorPayload(`No proxy route for ${req.method} ${req.url}`));
    return;
  }

  const credential = await ensureFreshCredential();
  const baseUrl = copilotBaseUrl(credential.access, credential.enterpriseDomain);
  const upstreamUrl = `${baseUrl}${routeInfo.upstreamPath}`;

  const bodyBuffer = routeInfo.kind === "models" ? null : await readBody(req);
  let bodyToSend: Buffer | null = bodyBuffer;
  let analysis: BodyAnalysis = { hasImage: false };
  let requestModel = "unknown";
  if (bodyBuffer !== null && bodyBuffer.length > 0) {
    try {
      const parsed = JSON.parse(bodyBuffer.toString("utf-8"));
      analysis = analyzeBody(parsed);
      if (typeof (parsed as { model?: unknown }).model === "string") {
        requestModel = (parsed as { model: string }).model;
      }
      const sanitized =
        routeInfo.kind === "chat"
          ? sanitizeChatCompletionsBody(parsed)
          : routeInfo.kind === "messages"
            ? sanitizeMessagesBody(parsed)
            : parsed;
      bodyToSend = Buffer.from(JSON.stringify(sanitized), "utf-8");
    } catch {
      // 非 JSON 请求体原样转发。
    }
  }
  void dumpRequest(routeInfo.kind, requestModel, bodyBuffer ?? Buffer.alloc(0));

  const headers: Record<string, string> = {
    Authorization: `Bearer ${credential.access}`,
    ...COPILOT_STATIC_HEADERS,
    "Openai-Intent": "conversation-edits",
    // 最后一条消息不是用户消息（如工具结果）时，本请求由 agent 发起。
    "X-Initiator": analysis.lastRole !== undefined && analysis.lastRole !== "user" ? "agent" : "user",
  };
  const clientAccept = req.headers.accept;
  if (clientAccept) headers.Accept = clientAccept;
  if (routeInfo.kind === "messages") {
    headers["anthropic-version"] = (req.headers["anthropic-version"] as string | undefined) ?? "2023-06-01";
  }
  if (routeInfo.kind === "models") {
    headers.Accept = "application/json";
    headers["X-GitHub-Api-Version"] = "2026-06-01";
    delete headers["Openai-Intent"];
    delete headers["X-Initiator"];
  }
  if (analysis.hasImage) {
    headers["Copilot-Vision-Request"] = "true";
  }
  if (bodyToSend !== null) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = String(bodyToSend.length);
  }

  const upstreamAbort = new AbortController();
  req.on("close", () => upstreamAbort.abort());

  let upstream: Response;
  const startedAt = Date.now();
  try {
    upstream = await fetch(upstreamUrl, {
      method: routeInfo.kind === "models" ? "GET" : "POST",
      headers,
      body: bodyToSend ?? undefined,
      signal: upstreamAbort.signal,
    });
  } catch (error) {
    if (upstreamAbort.signal.aborted) return; // 客户端已断开
    void proxyLog(`upstream fetch failed ${routeInfo.kind} model=${requestModel}: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }

  if (!upstream.ok) {
    const text = await upstream.text();
    void proxyLog(
      `upstream ${upstream.status} ${routeInfo.kind} model=${requestModel} ${Date.now() - startedAt}ms: ${text.slice(0, 800)}`,
    );
    sendJson(res, upstream.status, {
      error: { message: `Copilot API ${upstream.status}: ${text.slice(0, 2000)}`, type: "upstream_error" },
    });
    return;
  }
  if (routeInfo.kind !== "models") {
    void proxyLog(`upstream ${upstream.status} ${routeInfo.kind} model=${requestModel} ${Date.now() - startedAt}ms`);
  }

  const responseHeaders: Record<string, string> = {};
  const contentType = upstream.headers.get("content-type");
  if (contentType) responseHeaders["Content-Type"] = contentType;
  res.writeHead(upstream.status, responseHeaders);
  if (!upstream.body) {
    res.end();
    return;
  }
  const nodeStream = Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream);
  if (routeInfo.kind === "responses") {
    nodeStream.pipe(createResponsesItemRewriter()).pipe(res);
  } else if (routeInfo.kind === "chat") {
    nodeStream.pipe(createChatReasoningRewriter()).pipe(res);
  } else {
    nodeStream.pipe(res);
  }
  nodeStream.on("error", (error: unknown) => {
    void proxyLog(
      `stream aborted ${routeInfo.kind} model=${requestModel} ${Date.now() - startedAt}ms: ${error instanceof Error ? error.message : String(error)}`,
    );
    // 上游中断时尽量把已收到的部分写完。
    res.destroy(error instanceof Error ? error : new Error(String(error)));
  });
}
