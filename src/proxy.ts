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
 * SSE 流原样透传。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { COPILOT_STATIC_HEADERS, copilotBaseUrl } from "./copilot/constants.ts";
import { credentialStatus, ensureFreshCredential, NotLoggedInError } from "./token-manager.ts";

const MAX_BODY_BYTES = 256 * 1024 * 1024;

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
 * chat/completions 兼容性清洗（对齐 pi 的 compat 标志）：
 * - 移除 store（不支持）
 * - 移除 reasoning_effort（completions 模型不支持，responses 模型不会走此路由）
 * - developer 角色 → system（不支持 developer）
 */
function sanitizeChatCompletionsBody(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== "object") return parsed;
  const body = { ...(parsed as Record<string, unknown>) };
  delete body.store;
  delete body.reasoning_effort;
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
  if (bodyBuffer !== null && bodyBuffer.length > 0) {
    try {
      const parsed = JSON.parse(bodyBuffer.toString("utf-8"));
      analysis = analyzeBody(parsed);
      const sanitized = routeInfo.kind === "chat" ? sanitizeChatCompletionsBody(parsed) : parsed;
      bodyToSend = Buffer.from(JSON.stringify(sanitized), "utf-8");
    } catch {
      // 非 JSON 请求体原样转发。
    }
  }

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
  try {
    upstream = await fetch(upstreamUrl, {
      method: routeInfo.kind === "models" ? "GET" : "POST",
      headers,
      body: bodyToSend ?? undefined,
      signal: upstreamAbort.signal,
    });
  } catch (error) {
    if (upstreamAbort.signal.aborted) return; // 客户端已断开
    throw error;
  }

  if (!upstream.ok && !upstream.body) {
    const text = await upstream.text();
    sendJson(res, upstream.status, {
      error: { message: `Copilot API ${upstream.status}: ${text.slice(0, 2000)}`, type: "upstream_error" },
    });
    return;
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
  nodeStream.pipe(res);
  nodeStream.on("error", (error: unknown) => {
    // 上游中断时尽量把已收到的部分写完。
    res.destroy(error instanceof Error ? error : new Error(String(error)));
  });}
