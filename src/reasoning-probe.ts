/**
 * Claude 关闭思考机制的探测。
 *
 * /models 会声明每个模型的 reasoning_effort 档位，但 Claude 各模型对
 * "关闭思考" 请求体的接受形态不同（实测 2026-10）：
 * - 5.5 家族要求 thinking {type:"between_tools"}（标准 disabled 被拒绝并明确提示）；
 * - 4.x / 部分 5.x 接受标准 anthropic thinking {type:"disabled"}；
 * - opus-5.5 两者都拒绝，只能省略 thinking 字段。
 *
 * 每个 claude 模型最多 2 个微型请求即可确定。
 */

import { COPILOT_STATIC_HEADERS } from "./copilot/constants.ts";
import type { ClaudeThinkingOffType } from "./catalog.ts";

async function postThinkingOff(baseUrl: string, token: string, modelId: string, type: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...COPILOT_STATIC_HEADERS,
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
        thinking: { type },
      }),
      signal: AbortSignal.timeout(15000),
    });
    return response.status === 200;
  } catch {
    return false;
  }
}

/** 探测单个 Claude 模型的关闭思考机制。 */
export async function detectClaudeOffType(
  copilotToken: string,
  baseUrl: string,
  modelId: string,
): Promise<ClaudeThinkingOffType> {
  if (await postThinkingOff(baseUrl, copilotToken, modelId, "between_tools")) return "between_tools";
  if (await postThinkingOff(baseUrl, copilotToken, modelId, "disabled")) return "disabled";
  return "omit";
}
