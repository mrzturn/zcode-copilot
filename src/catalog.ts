/**
 * Copilot 模型分类与元数据，用于生成 ZCode 的模型配置规则。
 *
 * 分类与兼容性结论来自 pi 的 copilot 目录（packages/ai/catalog/providers/github-copilot.ts）：
 * - Claude 4.x/5.x 走 anthropic /v1/messages；
 * - gpt-* / grok-* / oswe* / mai-* 走 openai /responses；
 * - 其余模型走 openai /chat/completions（且不支持 store / developer 角色 / reasoning_effort）。
 *
 * 思考档位（reasoning effort）各模型支持集合不同，由 reasoning-probe.ts 在 setup 时
 * 实测确定；此处只保留探测失败时的静态回退值（实测于 2026-10 业务版订阅）。
 */

import { proxyBaseUrl } from "./copilot/constants.ts";
import type { ProviderPlan } from "./zcode-config.ts";

export type ModelFamily = "claude" | "responses" | "completions";

export function modelFamily(modelId: string): ModelFamily {
  if (/^claude-(haiku|sonnet|opus|fable)-[45]([.-]|$)/.test(modelId)) return "claude";
  if (/^(gpt-|grok-|oswe|mai-)/.test(modelId)) return "responses";
  return "completions";
}

/** 探测失败时的回退档位（不含 disabled/off 值）。 */
export type ReasoningFallbackKey = "claude" | "gpt" | "grok" | "completions";

export const STATIC_REASONING_FALLBACK: Record<ReasoningFallbackKey, string[]> = {
  claude: ["low", "medium", "high"],
  gpt: ["low", "medium", "high"],
  grok: ["minimal", "low", "medium", "high", "xhigh"],
  completions: [],
};

/** Claude 关闭思考的机制（实测各模型不同）：
 * - between_tools：5.5 家族要求（thinking disabled 已被拒绝）；
 * - disabled：4.x / 部分 5.x 接受标准 anthropic 形态；
 * - omit：只能省略 thinking 字段（CEL 空对象合并）。 */
export type ClaudeThinkingOffType = "between_tools" | "disabled" | "omit";

/** GitHub "扩展能力" 表格中支持 1M token 上下文的模型（来自 pi 目录维护的清单）。 */
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
  if (/^grok-/.test(modelId)) return 131_072;
  return 128_000;
}

function maxOutputTokensFor(modelId: string, family: ModelFamily): number {
  if (family === "claude") return 64_000;
  if (/^gpt-[56]/.test(modelId)) return 128_000;
  if (/^grok-/.test(modelId)) return 64_000;
  return 32_768;
}

/**
 * ZCode 档位值 → 请求参数的 CEL 映射。
 * - Claude：Copilot 的 /v1/messages 已不接受 thinking {type:enabled,budget_tokens}，
 *   按 400 报错提示改用 thinking adaptive + output_config.effort（low~max 实测可用）；
 *   关闭档按模型探测结果选 between_tools / disabled / 省略字段。
 * - responses：reasoning.effort 直接透传（none/minimal/…/max，以探测结果为准）。
 */
function reasoningMap(family: ModelFamily, offType: ClaudeThinkingOffType): string {
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
  return '{"reasoning": {"effort": reasoningLevel}}';
}

function maxOutputTokensMap(family: ModelFamily): string {
  if (family === "claude") return "{'max_tokens': maxOutputTokens}";
  if (family === "responses") return "{'max_output_tokens': maxOutputTokens}";
  return "{'max_completion_tokens': maxOutputTokens}";
}

function supportsImage(modelId: string, family: ModelFamily): boolean {
  if (family === "claude") return true;
  if (/^gpt-[56]/.test(modelId) || /^grok-/.test(modelId)) return true;
  void modelId;
  return false;
}

/** mid-conversation system 消息：pi 验证过 Copilot 对 claude / openai responses 家族可透传。 */
function supportsMidConversationSystem(modelId: string, family: ModelFamily): boolean {
  if (family === "claude" || family === "responses") return true;
  return modelId === "kimi-k3";
}

/**
 * 生成模型的 ZCode 配置。spec.efforts 为探测到的档位（不含关闭档）：
 * - claude：首位统一加 "disabled"（按 offType 映射为真正的关闭形态）；
 * - responses：直接使用探测值（支持 none 的模型以 none 作为关闭档）。
 */
export interface ModelReasoningInput {
  readonly efforts: readonly string[];
  readonly offType: ClaudeThinkingOffType;
}

export function buildModelConfig(modelId: string, spec: ModelReasoningInput): Record<string, unknown> {
  const family = modelFamily(modelId);
  const values =
    family === "claude"
      ? ["disabled", ...spec.efforts]
      : family === "responses"
        ? [...spec.efforts]
        : ["disabled"];
  return {
    enabled: true,
    properties: {
      contextWindow: contextWindowFor(modelId, family),
      inputFormat: {
        supportsText: true,
        supportsImage: supportsImage(modelId, family),
        supportsVideo: false,
        supportsAudio: false,
        supportsPdf: false,
      },
      outputFormat: { supportsText: true },
      supportsToolCall: true,
      supportsJsonSchemaOutput: false,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: supportsMidConversationSystem(modelId, family),
    },
    optionSpecs: {
      reasoningLevel: {
        values,
        map: family === "completions" ? "{}" : reasoningMap(family, spec.offType),
      },
      maxOutputTokens: { max: maxOutputTokensFor(modelId, family), map: maxOutputTokensMap(family) },
    },
  };
}

/** 按订阅可用模型生成要写入 ZCode 的提供商计划；specByModel 缺项用家族回退。 */
export function buildProviderPlans(
  availableModelIds: readonly string[],
  specByModel?: ReadonlyMap<string, ModelReasoningInput>,
): ProviderPlan[] {
  const byFamily = new Map<ModelFamily, string[]>();
  for (const modelId of availableModelIds) {
    const family = modelFamily(modelId);
    const list = byFamily.get(family) ?? [];
    list.push(modelId);
    byFamily.set(family, list);
  }
  const specFor = (modelId: string): ModelReasoningInput => {
    const family = modelFamily(modelId);
    const probed = specByModel?.get(modelId);
    if (probed) return probed;
    if (family === "responses") {
      return {
        efforts: /^grok-/.test(modelId) ? STATIC_REASONING_FALLBACK.grok : STATIC_REASONING_FALLBACK.gpt,
        offType: "omit",
      };
    }
    if (family === "claude") return { efforts: STATIC_REASONING_FALLBACK.claude, offType: "disabled" };
    return { efforts: [], offType: "omit" };
  };
  const base = proxyBaseUrl();
  const plans: ProviderPlan[] = [];
  const claudeIds = byFamily.get("claude") ?? [];
  if (claudeIds.length > 0) {
    plans.push({
      providerId: "copilot-claude",
      providerName: "GitHub Copilot (Claude)",
      apiType: "anthropic-messages",
      baseUrl: base,
      models: claudeIds.map((modelId) => ({ modelId, config: buildModelConfig(modelId, specFor(modelId)) })),
    });
  }
  const responsesIds = byFamily.get("responses") ?? [];
  if (responsesIds.length > 0) {
    plans.push({
      providerId: "copilot-gpt",
      providerName: "GitHub Copilot (GPT/Grok)",
      apiType: "openai-responses",
      baseUrl: `${base}/v1`,
      models: responsesIds.map((modelId) => ({ modelId, config: buildModelConfig(modelId, specFor(modelId)) })),
    });
  }
  const completionsIds = byFamily.get("completions") ?? [];
  if (completionsIds.length > 0) {
    plans.push({
      providerId: "copilot-openai",
      providerName: "GitHub Copilot (OpenAI Chat)",
      apiType: "openai-chat-completions",
      baseUrl: `${base}/v1`,
      models: completionsIds.map((modelId) => ({ modelId, config: buildModelConfig(modelId, { efforts: [], offType: "omit" }) })),
    });
  }
  return plans;
}
