/**
 * 一键接入编排：导入凭据 → 刷新令牌 → 拉模型 → policy 启用 → 写入 ZCode 提供商配置 → 确保 daemon。
 */

import { importFromPiIfAvailable, readCredential, writeCredential } from "./store.ts";
import { credentialStatus, ensureFreshCredential } from "./token-manager.ts";
import { checkDaemon, ensureDaemon } from "./daemon-manage.ts";
import { enableCopilotModels, fetchCopilotModels, type CopilotModelInfo } from "./copilot/models.ts";
import { copilotBaseUrl } from "./copilot/constants.ts";
import { buildProviderPlans, modelFamily, type ClaudeThinkingOffType } from "./catalog.ts";
import { detectClaudeOffType } from "./reasoning-probe.ts";
import { inspectCopilotProviders, upsertCopilotProviders } from "./zcode-config.ts";

export interface SetupSummary {
  ok: boolean;
  credentialImportedFromPi: boolean;
  loggedIn: boolean;
  message?: string;
  enabledPolicyModelIds?: string[];
  providers?: Array<{ providerId: string; providerName: string; apiType: string; baseUrl: string; models: string[] }>;
  daemonRunning: boolean;
}

function isEnableCandidate(modelId: string): boolean {
  const family = modelFamily(modelId);
  return family === "claude" || family === "responses" || modelId === "kimi-k3";
}

export async function runSetup(): Promise<SetupSummary> {
  const daemonBefore = await checkDaemon();

  const piImport = await importFromPiIfAvailable();
  const credential = await readCredential();
  if (!credential?.refresh) {
    return {
      ok: false,
      credentialImportedFromPi: piImport.imported,
      loggedIn: false,
      daemonRunning: daemonBefore.ok,
      message: "尚未登录 GitHub Copilot。请先调用 copilot_login 完成设备码登录，再执行 copilot_setup。",
    };
  }

  // 刷新令牌（过期或临近过期时），为拉模型列表做准备。
  let copilotToken: string;
  let enterpriseDomain: string | undefined;
  let availableModelIds: string[] = [];
  try {
    const fresh = await ensureFreshCredential();
    copilotToken = fresh.access;
    enterpriseDomain = fresh.enterpriseDomain;
  } catch (error) {
    return {
      ok: false,
      credentialImportedFromPi: piImport.imported,
      loggedIn: true,
      daemonRunning: daemonBefore.ok,
      message: `刷新 Copilot 令牌失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  let enabledIds: string[] = [];
  let catalogModels: CopilotModelInfo[] = [];
  try {
    const catalog = await fetchCopilotModels(copilotToken, enterpriseDomain);
    const enableTargets = catalog.policyModelIds.filter(isEnableCandidate);
    enabledIds = enableTargets.length > 0 ? await enableCopilotModels(copilotToken, enableTargets, enterpriseDomain) : [];
    availableModelIds = [...new Set([...catalog.availableModelIds, ...enabledIds])];
    catalogModels = catalog.models;
    const current = await readCredential();
    if (current) {
      await writeCredential({ ...current, availableModelIds });
    }
  } catch (error) {
    // 模型列表失败时退回登录时缓存的列表。
    availableModelIds = (await readCredential())?.availableModelIds ?? [];
    if (availableModelIds.length === 0) {
      return {
        ok: false,
        credentialImportedFromPi: piImport.imported,
        loggedIn: true,
        daemonRunning: daemonBefore.ok,
        message: `拉取 Copilot 模型列表失败：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  const availableSet = new Set(availableModelIds);
  const availableModels = catalogModels.filter((model) => availableSet.has(model.id));
  if (availableModels.length !== availableModelIds.length) {
    // 模型列表拉取失败退回缓存时缺少元数据，构造降级信息（catalog 走静态回退）。
    for (const modelId of availableModelIds) {
      if (!availableModels.some((model) => model.id === modelId)) {
        availableModels.push({ id: modelId, pickerEnabled: true, supportsToolCalls: true, degraded: true });
      }
    }
  }

  if (availableModelIds.length === 0) {
    return {
      ok: false,
      credentialImportedFromPi: piImport.imported,
      loggedIn: true,
      daemonRunning: daemonBefore.ok,
      message: "订阅没有可用的模型（均不支持工具调用或被禁用）。",
    };
  }

  // 思考档位与上下文等元数据直接使用 /models 声明（catalog 内部回退静态值）；
  // 仅 Claude 的"关闭思考"请求形态需要逐模型实测（各代际不同）。
  const offTypes = new Map<string, ClaudeThinkingOffType>();
  try {
    const baseUrl = copilotBaseUrl(copilotToken, enterpriseDomain);
    for (const model of availableModels) {
      if (modelFamily(model.id) !== "claude") continue;
      offTypes.set(model.id, await detectClaudeOffType(copilotToken, baseUrl, model.id));
    }
  } catch {
    // 探测失败时统一回退 "disabled"。
  }

  const plans = buildProviderPlans(availableModels, offTypes);
  const { backupPath } = await upsertCopilotProviders(plans);
  const daemon = await ensureDaemon();
  const status = await credentialStatus();

  return {
    ok: true,
    credentialImportedFromPi: piImport.imported,
    loggedIn: true,
    enabledPolicyModelIds: enabledIds,
    providers: plans.map((plan) => ({
      providerId: plan.providerId,
      providerName: plan.providerName,
      apiType: plan.apiType,
      baseUrl: plan.baseUrl,
      models: plan.models.map((model) => {
        const levels = (model.config.optionSpecs as { reasoningLevel?: { values?: string[] } }).reasoningLevel?.values ?? [];
        return `${model.modelId}${levels.length > 0 ? ` (${levels.join("/")})` : ""}`;
      }),
    })),
    daemonRunning: daemon.ok,
    message: [
      `已注册 ${plans.length} 个提供商 / ${availableModelIds.length} 个模型。`,
      backupPath ? `配置备份：${backupPath}` : undefined,
      status.baseUrl ? `Copilot API：${status.baseUrl}` : undefined,
    ]
      .filter(Boolean)
      .join(" "),
  };
}

export async function setupStatusView(): Promise<{
  credential: Awaited<ReturnType<typeof credentialStatus>>;
  daemon: Awaited<ReturnType<typeof checkDaemon>>;
  providers: Awaited<ReturnType<typeof inspectCopilotProviders>>;
}> {
  const [credential, daemon, providers] = await Promise.all([
    credentialStatus(),
    checkDaemon(),
    inspectCopilotProviders().catch(() => []),
  ]);
  return { credential, daemon, providers };
}
