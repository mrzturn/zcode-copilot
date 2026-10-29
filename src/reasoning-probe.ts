/**
 * 探测每个 Copilot 模型实际支持的思考档位（reasoning effort）。
 *
 * 实测（2026-10，业务版订阅）各模型支持集合互不相同，例如：
 *   claude-sonnet-5.5   [low medium high xhigh max]（output_config.effort）
 *   claude-haiku-4.5    不支持思考
 *   gpt-6-luna          [none minimal low medium high xhigh max]
 *   gpt-6.1-sol         [low medium high xhigh max]
 *   gpt-5.3-codex       [none low medium high xhigh]
 *   grok-4.7            [minimal low medium high xhigh]（错误不枚举，静态回退）
 *
 * 上游错误信息会枚举模型级支持列表，因此用 1~3 个微型请求即可精确确定：
 * - claude（/v1/messages）：发非法 effort → "supported values: [low medium …]"
 *   或 "does not support reasoning effort"（无思考）。
 * - gpt 系（/responses）：发 "minimal"；若被拒则解析 "Supported values are: …"；
 *   若接受再试 "none" / "max" 补全。
 * - grok 系错误为泛化 400，无法枚举 → 使用静态回退集合。
 */

import { COPILOT_STATIC_HEADERS, sleep } from "./copilot/constants.ts";
import { modelFamily, STATIC_REASONING_FALLBACK, type ClaudeThinkingOffType } from "./catalog.ts";

const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type Effort = (typeof EFFORT_ORDER)[number];

/** 模型思考能力：支持档位 + Claude 关闭机制。 */
export interface ModelReasoningSpec {
  readonly efforts: string[];
  readonly offType: ClaudeThinkingOffType;
}

function parseSupportedList(message: string): string[] | null {
  const match = /Supported values are: ([^.]+)/u.exec(message) ?? /supported values: \[([^\]]+)\]/u.exec(message);
  if (!match?.[1]) return null;
  const values = match[1]
    .split(/['\s,]+/)
    .map((value) => value.trim())
    .filter((value) => (EFFORT_ORDER as readonly string[]).includes(value));
  return values.length > 0 ? values : null;
}

async function postJson(url: string, token: string, body: unknown, timeoutMs = 15000): Promise<{ status: number; message: string }> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...COPILOT_STATIC_HEADERS,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let message = text;
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } | string };
    if (typeof parsed.error === "string") message = parsed.error;
    else if (parsed.error && typeof parsed.error.message === "string") message = parsed.error.message;
    // Copilot /responses 的错误体是双层 JSON 字符串。
    const nested = /^\s*\{/.test(message) ? (JSON.parse(message) as { error?: { message?: unknown } }) : null;
    if (nested?.error && typeof nested.error.message === "string") message = nested.error.message;
  } catch {
    // 保留原始文本。
  }
  return { status: response.status, message };
}

async function probeClaudeOff(baseUrl: string, token: string, modelId: string): Promise<ClaudeThinkingOffType> {
  // 5.5 家族要求 between_tools；4.x/部分 5.x 接受标准 disabled；都不行则只能省略字段。
  const betweenTools = await postJson(`${baseUrl}/v1/messages`, token, {
    model: modelId,
    max_tokens: 16,
    messages: [{ role: "user", content: "hi" }],
    thinking: { type: "between_tools" },
  });
  if (betweenTools.status === 200) return "between_tools";
  const disabled = await postJson(`${baseUrl}/v1/messages`, token, {
    model: modelId,
    max_tokens: 16,
    messages: [{ role: "user", content: "hi" }],
    thinking: { type: "disabled" },
  });
  if (disabled.status === 200) return "disabled";
  return "omit";
}

async function probeClaude(baseUrl: string, token: string, modelId: string): Promise<ModelReasoningSpec> {
  const offType = await probeClaudeOff(baseUrl, token, modelId);
  const result = await postJson(`${baseUrl}/v1/messages`, token, {
    model: modelId,
    max_tokens: 16,
    messages: [{ role: "user", content: "hi" }],
    thinking: { type: "adaptive" },
    output_config: { effort: "ultra" },
  });
  if (result.status === 200) {
    return { efforts: STATIC_REASONING_FALLBACK.claude, offType };
  }
  if (/does not support reasoning effort/i.test(result.message)) {
    return { efforts: [], offType };
  }
  const efforts = parseSupportedList(result.message) ?? STATIC_REASONING_FALLBACK.claude;
  return { efforts, offType };
}

async function probeResponsesOnce(baseUrl: string, token: string, modelId: string, effort: Effort): Promise<{ status: number; message: string }> {
  return postJson(`${baseUrl}/responses`, token, {
    model: modelId,
    input: "hi",
    max_output_tokens: 16,
    reasoning: { effort },
  });
}

async function probeResponses(baseUrl: string, token: string, modelId: string): Promise<ModelReasoningSpec> {
  const offType: ClaudeThinkingOffType = "omit";
  const minimal = await probeResponsesOnce(baseUrl, token, modelId, "minimal");
  if (minimal.status !== 200) {
    // gpt-5.3-codex / gpt-6.1-sol 等：错误里枚举模型级支持列表。
    if (/Bad Request/.test(minimal.message) && !/Supported values/.test(minimal.message)) {
      return { efforts: STATIC_REASONING_FALLBACK.grok, offType };
    }
    return { efforts: parseSupportedList(minimal.message) ?? STATIC_REASONING_FALLBACK.gpt, offType };
  }
  // minimal 可用：再确认 none 与 max 两个端点，命中即得到完整集合。
  const none = await probeResponsesOnce(baseUrl, token, modelId, "none");
  if (none.status !== 200) {
    return { efforts: parseSupportedList(none.message) ?? STATIC_REASONING_FALLBACK.gpt, offType };
  }
  const max = await probeResponsesOnce(baseUrl, token, modelId, "max");
  if (max.status !== 200) {
    return { efforts: parseSupportedList(max.message) ?? STATIC_REASONING_FALLBACK.gpt, offType };
  }
  return { efforts: [...EFFORT_ORDER], offType };
}

/**
 * 探测单个模型的思考能力。efforts 不含关闭档（ZCode 侧按家族统一处理）；
 * offType 是 Claude 的关闭机制（responses 家族不使用）。
 */
export async function detectModelReasoning(
  copilotToken: string,
  baseUrl: string,
  modelId: string,
): Promise<ModelReasoningSpec> {
  const family = modelFamily(modelId);
  try {
    if (family === "claude") return await probeClaude(baseUrl, copilotToken, modelId);
    if (family === "responses") {
      if (/^grok-/.test(modelId)) return { efforts: STATIC_REASONING_FALLBACK.grok, offType: "omit" };
      return await probeResponses(baseUrl, copilotToken, modelId);
    }
    return { efforts: [], offType: "omit" };
  } catch {
    if (family === "claude") return { efforts: STATIC_REASONING_FALLBACK.claude, offType: "disabled" };
    if (family === "responses") {
      return {
        efforts: /^grok-/.test(modelId) ? STATIC_REASONING_FALLBACK.grok : STATIC_REASONING_FALLBACK.gpt,
        offType: "omit",
      };
    }
    return { efforts: [], offType: "omit" };
  }
}

/** 并发探测一批模型，返回 modelId → 思考能力。 */
export async function detectReasoningForModels(
  copilotToken: string,
  baseUrl: string,
  modelIds: readonly string[],
  options: { concurrency?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<Map<string, ModelReasoningSpec>> {
  const concurrency = options.concurrency ?? 4;
  const results = new Map<string, ModelReasoningSpec>();
  const queue = [...modelIds];
  let done = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const modelId = queue.shift();
      if (!modelId) return;
      const spec = await detectModelReasoning(copilotToken, baseUrl, modelId);
      results.set(modelId, spec);
      done += 1;
      options.onProgress?.(done, queue.length + done);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, modelIds.length) }, () => worker()));
  // 探测请求密集，稍微错开避免触发限流。
  await sleep(200);
  return results;
}
