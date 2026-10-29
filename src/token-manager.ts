/**
 * 令牌管理器：代理进程内使用。每次请求前确保 Copilot 令牌可用，
 * 临近过期时串行刷新（单飞），写回 store。
 */

import { readCredential, writeCredential } from "./store.ts";
import { isFresh, refreshCredential, type CopilotCredential } from "./copilot/token.ts";
import { copilotBaseUrl } from "./copilot/constants.ts";

export class NotLoggedInError extends Error {
  constructor() {
    super(
      "GitHub Copilot 未登录。请先调用 copilot_login 工具（或运行 `node dist/cli.mjs login`）完成设备码登录。",
    );
    this.name = "NotLoggedInError";
  }
}

let refreshInFlight: Promise<CopilotCredential> | null = null;

/**
 * 取可用凭据；未登录抛 NotLoggedInError，过期则刷新（并发调用共享同一次刷新）。
 */
export async function ensureFreshCredential(): Promise<CopilotCredential> {
  const credential = await readCredential();
  if (!credential?.refresh) throw new NotLoggedInError();
  if (isFresh(credential)) return credential;
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      // 双检：等锁期间可能已被其他流程刷新。
      const current = (await readCredential()) ?? credential;
      if (isFresh(current)) return current;
      const refreshed = await refreshCredential(current);
      await writeCredential(refreshed);
      return refreshed;
    })().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

/** 当前凭据状态（不触发刷新），供 /health 与状态展示。 */
export async function credentialStatus(): Promise<{
  loggedIn: boolean;
  expiresAt?: number;
  baseUrl?: string;
  availableModelCount?: number;
}> {
  const credential = await readCredential();
  if (!credential?.refresh) return { loggedIn: false };
  return {
    loggedIn: true,
    expiresAt: credential.expires,
    baseUrl: credential.access ? copilotBaseUrl(credential.access, credential.enterpriseDomain) : undefined,
    availableModelCount: credential.availableModelIds?.length ?? 0,
  };
}
