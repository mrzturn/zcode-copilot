/**
 * 一键接入编排：导入凭据 → 刷新令牌 → 拉模型 → policy 启用 → 写入 ZCode 提供商配置 → 确保 daemon。
 */

import { importFromPiIfAvailable, readCredential, writeCredential } from "./store.ts";
import { credentialStatus, ensureFreshCredential } from "./token-manager.ts";
import { checkDaemon, ensureDaemon } from "./daemon-manage.ts";
import { enableCopilotModels, fetchCopilotModels } from "./copilot/models.ts";
import { buildProviderPlans, modelFamily } from "./catalog.ts";
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
  try {
    const catalog = await fetchCopilotModels(copilotToken, enterpriseDomain);
    const enableTargets = catalog.policyModelIds.filter(isEnableCandidate);
    enabledIds = enableTargets.length > 0 ? await enableCopilotModels(copilotToken, enableTargets, enterpriseDomain) : [];
    availableModelIds = [...new Set([...catalog.availableModelIds, ...enabledIds])];
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

  if (availableModelIds.length === 0) {
    return {
      ok: false,
      credentialImportedFromPi: piImport.imported,
      loggedIn: true,
      daemonRunning: daemonBefore.ok,
      message: "订阅没有可用的模型（均不支持工具调用或被禁用）。",
    };
  }

  const plans = buildProviderPlans(availableModelIds);
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
      models: plan.models.map((model) => model.modelId),
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
