/**
 * Copilot 模型分类与元数据，用于生成 ZCode 的模型配置规则。
 *
 * 分类与兼容性结论来自 pi 的 copilot 目录（packages/ai/catalog/providers/github-copilot.ts）：
 * - Claude 4.x/5.x 走 anthropic /v1/messages；
 * - gpt-* / grok-* / oswe* / mai-* 走 openai /responses；
 * - 其余模型走 openai /chat/completions（且不支持 store / developer 角色 / reasoning_effort）。
 */

import { proxyBaseUrl } from "./copilot/constants.ts";
import type { ProviderPlan } from "./zcode-config.ts";

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

export type ModelFamily = "claude" | "responses" | "completions";

export function modelFamily(modelId: string): ModelFamily {
  if (/^claude-(haiku|sonnet|opus|fable)-[45]([.-]|$)/.test(modelId)) return "claude";
  if (/^(gpt-|grok-|oswe|mai-)/.test(modelId)) return "responses";
  return "completions";
}

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

function reasoningSpec(modelId: string, family: ModelFamily): { values: string[]; map: string } {
  if (family === "claude") {
    if (/^claude-haiku/.test(modelId)) {
      return { values: ["disabled"], map: "{}" };
    }
    // 标准 anthropic thinking；budget 与档位挂钩（需 > 1024 且小于 max_tokens）。
    return {
      values: ["disabled", "low", "medium", "high"],
      map: [
        'reasoningLevel == "disabled"',
        "? {\"thinking\": {\"type\": \"disabled\"}}",
        ": {\"thinking\": {\"type\": \"enabled\", \"budget_tokens\": reasoningLevel == \"low\" ? 2048 : reasoningLevel == \"high\" ? 16384 : 8192}}",
      ].join(" "),
    };
  }
  if (family === "responses") {
    if (/^grok-/.test(modelId)) {
      return { values: ["low", "high"], map: "{\"reasoning\": {\"effort\": reasoningLevel}}" };
    }
    return { values: ["low", "medium", "high"], map: "{\"reasoning\": {\"effort\": reasoningLevel}}" };
  }
  // completions 家族不支持 reasoning_effort（pi compat 标志）。
  return { values: ["disabled"], map: "{}" };
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

export function buildModelConfig(modelId: string): Record<string, unknown> {
  const family = modelFamily(modelId);
  const reasoning = reasoningSpec(modelId, family);
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
      reasoningLevel: { values: reasoning.values, map: reasoning.map },
      maxOutputTokens: { max: maxOutputTokensFor(modelId, family), map: maxOutputTokensMap(family) },
    },
  };
}

/** 按订阅可用模型生成要写入 ZCode 的提供商计划（按家族分组）。 */
export function buildProviderPlans(availableModelIds: readonly string[]): ProviderPlan[] {
  const byFamily = new Map<ModelFamily, string[]>();
  for (const modelId of availableModelIds) {
    const family = modelFamily(modelId);
    const list = byFamily.get(family) ?? [];
    list.push(modelId);
    byFamily.set(family, list);
  }
  const base = proxyBaseUrl();
  const plans: ProviderPlan[] = [];
  const claudeIds = byFamily.get("claude") ?? [];
  if (claudeIds.length > 0) {
    plans.push({
      providerId: "copilot-claude",
      providerName: "GitHub Copilot (Claude)",
      apiType: "anthropic-messages",
      baseUrl: base,
      models: claudeIds.map((modelId) => ({ modelId, config: buildModelConfig(modelId) })),
    });
  }
  const responsesIds = byFamily.get("responses") ?? [];
  if (responsesIds.length > 0) {
    plans.push({
      providerId: "copilot-gpt",
      providerName: "GitHub Copilot (GPT/Grok)",
      apiType: "openai-responses",
      baseUrl: `${base}/v1`,
      models: responsesIds.map((modelId) => ({ modelId, config: buildModelConfig(modelId) })),
    });
  }
  const completionsIds = byFamily.get("completions") ?? [];
  if (completionsIds.length > 0) {
    plans.push({
      providerId: "copilot-openai",
      providerName: "GitHub Copilot (OpenAI Chat)",
      apiType: "openai-chat-completions",
      baseUrl: `${base}/v1`,
      models: completionsIds.map((modelId) => ({ modelId, config: buildModelConfig(modelId) })),
    });
  }
  return plans;
}
