/**
 * Copilot 模型目录：GET /models 拉取订阅可用模型，POST /models/{id}/policy 启用模型。
 */

import { COPILOT_API_VERSION, COPILOT_STATIC_HEADERS, copilotBaseUrl, sleep } from "./constants.ts";

export interface CopilotModelInfo {
  id: string;
  /** 是否出现在 GitHub 官方模型选择器中。 */
  pickerEnabled: boolean;
  /** enabled / disabled / unconfigured。unconfigured 的模型需要 policy enable。 */
  policyState?: string;
  /** 工具调用能力（false 的模型对 coding agent 无用，直接过滤）。 */
  supportsToolCalls: boolean;
  name?: string;
  vendor?: string;
}

export interface CopilotModelCatalog {
  models: CopilotModelInfo[];
  /** picker 开启且未被禁用的模型。 */
  availableModelIds: string[];
  /** 处于 unconfigured 且值得尝试 policy enable 的模型。 */
  policyModelIds: string[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

export function parseCopilotModelCatalog(raw: unknown, allowPolicyFallback: boolean): CopilotModelCatalog {
  const data = asRecord(raw)?.data;
  if (!Array.isArray(data)) throw new Error("Invalid Copilot models response");

  const models: CopilotModelInfo[] = [];
  for (const rawItem of data) {
    const item = asRecord(rawItem);
    const id = item?.id;
    if (!item || typeof id !== "string") continue;
    const capabilities = asRecord(item.capabilities);
    const supports = asRecord(capabilities?.supports);
    if (supports?.tool_calls === false) continue;
    models.push({
      id,
      pickerEnabled: item.model_picker_enabled === true,
      policyState: asRecord(item.policy)?.state as string | undefined,
      supportsToolCalls: supports?.tool_calls !== false,
      name: typeof item.name === "string" ? item.name : undefined,
      vendor: typeof item.vendor === "string" ? item.vendor : undefined,
    });
  }

  const pickerModelIds = models.filter((m) => m.pickerEnabled && m.policyState !== "disabled").map((m) => m.id);
  const usePolicyFallback = allowPolicyFallback && pickerModelIds.length === 0;
  const availableModelIds =
    pickerModelIds.length > 0 || !allowPolicyFallback
      ? pickerModelIds
      : models.filter((m) => m.policyState === "enabled").map((m) => m.id);
  const policyModelIds = models
    .filter((m) => m.policyState === "unconfigured" && (m.pickerEnabled || usePolicyFallback))
    .map((m) => m.id);
  return { models, availableModelIds, policyModelIds };
}

export async function fetchCopilotModels(
  copilotToken: string,
  enterpriseDomain?: string,
  signal?: AbortSignal,
): Promise<CopilotModelCatalog> {
  const baseUrl = copilotBaseUrl(copilotToken, enterpriseDomain);
  // 部分个人账号所有 picker 标志位都是 false，需要策略回退；其他账号类型保持严格语义。
  const allowPolicyFallback = baseUrl === "https://api.individual.githubcopilot.com";
  const response = await fetchWithRateLimitRetry(
    `${baseUrl}/models`,
    {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${copilotToken}`,
        ...COPILOT_STATIC_HEADERS,
        "X-GitHub-Api-Version": COPILOT_API_VERSION,
      },
      signal,
    },
    { maxRetries: 2, maxElapsedMs: 8000 },
  );
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${(await response.text()).slice(0, 300)}`);
  }
  return parseCopilotModelCatalog(await response.json(), allowPolicyFallback);
}

async function fetchWithRateLimitRetry(
  url: string,
  init: RequestInit,
  retryPolicy: { maxRetries: number; maxElapsedMs: number },
): Promise<Response> {
  for (let retry = 0; ; retry++) {
    const response = await fetch(url, { ...init, signal: init.signal });
    if (response.status !== 429 || retry >= retryPolicy.maxRetries) return response;
    const retryAfter = response.headers.get("retry-after");
    let delayMs = 500 * 2 ** retry;
    if (retryAfter) {
      const seconds = Number.parseFloat(retryAfter);
      delayMs = Number.isNaN(seconds) ? Date.parse(retryAfter) - Date.now() : seconds * 1000;
      if (!Number.isFinite(delayMs)) return response;
    }
    if (Date.now() + Math.max(0, delayMs) >= Date.now() + retryPolicy.maxElapsedMs) return response;
    await sleep(Math.max(0, delayMs));
  }
}

/** 启用单个模型（部分模型如 Claude/Grok 首次使用前必须启用）。 */
export async function enableCopilotModel(
  copilotToken: string,
  modelId: string,
  enterpriseDomain?: string,
): Promise<boolean> {
  const baseUrl = copilotBaseUrl(copilotToken, enterpriseDomain);
  try {
    const response = await fetchWithRateLimitRetry(
      `${baseUrl}/models/${encodeURIComponent(modelId)}/policy`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${copilotToken}`,
          ...COPILOT_STATIC_HEADERS,
          "openai-intent": "chat-policy",
          "x-interaction-type": "chat-policy",
        },
        body: JSON.stringify({ state: "enabled" }),
      },
      { maxRetries: 2, maxElapsedMs: 5000 },
    );
    return response.ok;
  } catch {
    return false;
  }
}

/** 批量启用，尽力而为；限流耗尽时停止后续。 */
export async function enableCopilotModels(
  copilotToken: string,
  modelIds: readonly string[],
  enterpriseDomain?: string,
): Promise<string[]> {
  const enabled: string[] = [];
  for (const modelId of modelIds) {
    if (await enableCopilotModel(copilotToken, modelId, enterpriseDomain)) {
      enabled.push(modelId);
    }
  }
  return enabled;
}
