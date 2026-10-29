/**
 * Copilot 模型分类与元数据，用于生成 ZCode 的模型配置规则。
 *
 * 分类与兼容性结论来自 pi 的 copilot 目录（packages/ai/catalog/providers/github-copilot.ts）：
 * - Claude 4.x/5.x 走 anthropic /v1/messages；
 * - gpt-* / grok-* / oswe* / mai-* 走 openai /responses；
 * - 其余模型（gemini / kimi 等）走 openai /chat/completions。
 *
 * 思考档位与上下文/输出上限优先使用 /models 声明的能力（capabilities.supports.
 * reasoning_effort / capabilities.limits），声明缺失时回退本文件的静态值。
 */

import { proxyBaseUrl } from "./copilot/constants.ts";
import type { CopilotModelInfo } from "./copilot/models.ts";
import type { CopilotProviderId, ProviderPlan } from "./zcode-config.ts";

export type ModelFamily = "claude" | "responses" | "completions";

export function modelFamily(modelId: string): ModelFamily {
  if (/^claude-(haiku|sonnet|opus|fable)-[45]([.-]|$)/.test(modelId)) return "claude";
  if (/^(gpt-|grok-|oswe|mai-)/.test(modelId)) return "responses";
  return "completions";
}

/** Claude 关闭思考的机制（实测各模型不同）：
 * - between_tools：5.5 家族要求（thinking disabled 已被拒绝）；
 * - disabled：4.x / 部分 5.x 接受标准 anthropic 形态；
 * - omit：只能省略 thinking 字段（CEL 空对象合并）。 */
export type ClaudeThinkingOffType = "between_tools" | "disabled" | "omit";

/** /models 声明缺失时的回退值（实测于 2026-10 业务版订阅）。 */
export const STATIC_REASONING_FALLBACK: Record<"claude" | "gpt" | "grok" | "completions", string[]> = {
  claude: ["low", "medium", "high"],
  gpt: ["low", "medium", "high"],
  grok: ["low", "medium", "high", "xhigh"],
  completions: [],
};

/** GitHub "扩展能力" 表格中支持 1M token 上下文的模型（声明缺失时的回退）。 */
const EXTENDED_CONTEXT_MODEL_IDS = new Set([
  "claude-fable-5",
  "claude-opus-4.8",
  "claude-opus-5",
  "claude-opus-5.5",
  "claude-sonnet-4.6",
  "claude-sonnet-5",
  "gpt-5.3-codex",
  "gpt-6-astra",
  "gpt-6-luna",
  "gpt-6-sol",
]);

function contextWindowFor(modelId: string, family: ModelFamily): number {
  if (EXTENDED_CONTEXT_MODEL_IDS.has(modelId)) return 1_000_000;
  if (family === "claude") return 200_000;
  if (/^gpt-[56]/.test(modelId)) return 400_000;
  if (/^grok-/.test(modelId)) return 500_000;
  return 128_000;
}

function maxOutputTokensFor(modelId: string, family: ModelFamily): number {
  if (family === "claude") return 64_000;
  if (/^gpt-[56]/.test(modelId) || /^grok-/.test(modelId)) return 128_000;
  return 32_768;
}

/**
 * ZCode 档位值 → 请求参数的 CEL 映射。
 * - Claude：thinking adaptive + output_config.effort（400 报错指定的形态），
 *   关闭档按模型探测结果选 between_tools / disabled / 省略字段。
 * - responses：reasoning.effort 直接透传。
 * - completions（gemini / kimi 等）：reasoning_effort 直接透传。
 */
function reasoningMap(family: ModelFamily, offType: ClaudeThinkingOffType, hasEfforts: boolean): string {
  if (!hasEfforts) return "{}";
  if (family === "claude") {
    const offValue =
      offType === "between_tools"
        ? '{"thinking": {"type": "between_tools"}}'
        : offType === "disabled"
          ? '{"thinking": {"type": "disabled"}}'
          : "{}";
    return [
      'reasoningLevel == "disabled"',
      `? ${offValue}`,
      ': {"thinking": {"type": "adaptive"}, "output_config": {"effort": reasoningLevel}}',
    ].join(" ");
  }
  if (family === "responses") return '{"reasoning": {"effort": reasoningLevel}}';
  return '{"reasoning_effort": reasoningLevel}';
}

function maxOutputTokensMap(family: ModelFamily): string {
  if (family === "claude") return "{'max_tokens': maxOutputTokens}";
  if (family === "responses") return "{'max_output_tokens': maxOutputTokens}";
  return "{'max_completion_tokens': maxOutputTokens}";
}

/**
 * 生成模型的 ZCode 配置。
 * - claude：首位统一加 "disabled"，其余使用声明/回退档位；
 * - responses / completions：直接使用声明档位（支持 none 的模型以 none 作为关闭档）。
 */
export function buildModelConfig(
  model: CopilotModelInfo,
  offType: ClaudeThinkingOffType,
): Record<string, unknown> {
  const family = modelFamily(model.id);
  // /models 的 reasoning_effort 声明是权威来源：声明缺失即不支持思考；
  // 仅降级路径（拿不到元数据的缓存 ID）才使用家族静态回退。
  const efforts = model.degraded
    ? family === "claude"
      ? STATIC_REASONING_FALLBACK.claude
      : family === "responses"
        ? /^grok-/.test(model.id)
          ? STATIC_REASONING_FALLBACK.grok
          : STATIC_REASONING_FALLBACK.gpt
        : STATIC_REASONING_FALLBACK.completions
    : (model.reasoningEfforts ?? []);
  const values = family === "claude" ? ["disabled", ...efforts] : [...efforts];
  const vision = model.vision ?? (family === "claude" || /^gpt-[56]/.test(model.id) || /^grok-/.test(model.id));
  const contextWindow = model.contextWindow ?? contextWindowFor(model.id, family);
  const maxOutputTokens = model.maxOutputTokens ?? maxOutputTokensFor(model.id, family);
  return {
    enabled: true,
    properties: {
      contextWindow,
      inputFormat: {
        supportsText: true,
        supportsImage: vision,
        supportsVideo: false,
        supportsAudio: false,
        supportsPdf: model.pdf === true,
      },
      outputFormat: { supportsText: true },
      supportsToolCall: true,
      supportsJsonSchemaOutput: false,
      supportsNativeWebSearch: false,
      // pi 验证过 Copilot 对 claude / openai 家族可透传 mid-conversation system。
      supportsMidConversationSystem: family !== "completions" || model.id === "kimi-k3",
    },
    optionSpecs: {
      reasoningLevel: {
        values,
        map: reasoningMap(family, offType, values.length > 0 && !(values.length === 1 && values[0] === "disabled")),
      },
      maxOutputTokens: { max: maxOutputTokens, map: maxOutputTokensMap(family) },
    },
  };
}

/** 按订阅可用模型生成要写入 ZCode 的提供商计划。offTypes 为 Claude 关闭机制探测结果。 */
export function buildProviderPlans(
  availableModels: readonly CopilotModelInfo[],
  offTypes: ReadonlyMap<string, ClaudeThinkingOffType> = new Map(),
): ProviderPlan[] {
  const byFamily = new Map<ModelFamily, CopilotModelInfo[]>();
  for (const model of availableModels) {
    const family = modelFamily(model.id);
    const list = byFamily.get(family) ?? [];
    list.push(model);
    byFamily.set(family, list);
  }
  const toPlan = (
    family: ModelFamily,
    providerId: CopilotProviderId,
    providerName: string,
    apiType: ProviderPlan["apiType"],
    baseUrl: string,
  ): ProviderPlan => ({
    providerId,
    providerName,
    apiType,
    baseUrl,
    models: (byFamily.get(family) ?? []).map((model) => ({
      modelId: model.id,
      config: buildModelConfig(model, offTypes.get(model.id) ?? "disabled"),
    })),
  });
  const base = proxyBaseUrl();
  const plans: ProviderPlan[] = [];
  if ((byFamily.get("claude") ?? []).length > 0) {
    plans.push(toPlan("claude", "copilot-claude", "GitHub Copilot (Claude)", "anthropic-messages", base));
  }
  if ((byFamily.get("responses") ?? []).length > 0) {
    plans.push(toPlan("responses", "copilot-gpt", "GitHub Copilot (GPT/Grok)", "openai-responses", `${base}/v1`));
  }
  if ((byFamily.get("completions") ?? []).length > 0) {
    plans.push(toPlan("completions", "copilot-openai", "GitHub Copilot (OpenAI Chat)", "openai-chat-completions", `${base}/v1`));
  }
  return plans;
}
