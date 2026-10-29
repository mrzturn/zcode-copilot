/**
 * Copilot API 令牌管理：用 GitHub 用户令牌（ghu_…）换取短期 Copilot 令牌，
 * 并在临近过期时自动刷新。凭据落盘由 store.ts 负责。
 */

import { COPILOT_STATIC_HEADERS, copilotBaseUrl, copilotUrls, fetchJson } from "./constants.ts";

/** 落盘的 Copilot 凭据（对应 pi 的 OAuthCredential）。 */
export interface CopilotCredential {
  /** GitHub OAuth 用户令牌（ghu_…），长期有效，用于换取 access。 */
  refresh: string;
  /** 短期 Copilot API 令牌（tid=…;exp=…;… 形式的 blob）。 */
  access: string;
  /** access 的失效时刻（毫秒时间戳，已提前 5 分钟）。 */
  expires: number;
  enterpriseDomain?: string;
  /** 登录/设置时拉取的订阅可用模型 ID。 */
  availableModelIds?: string[];
}

export const REFRESH_LEEWAY_MS = 5 * 60 * 1000;

export interface ExchangeResult {
  access: string;
  /** 原始 expires_at（Unix 秒）。 */
  expiresAtSeconds: number;
  baseUrl: string;
}

/** 用 ghu_ 令牌换取短期 Copilot 令牌。 */
export async function exchangeCopilotToken(
  refreshToken: string,
  enterpriseDomain?: string,
  signal?: AbortSignal,
): Promise<ExchangeResult> {
  const domain = enterpriseDomain || "github.com";
  const raw = (await fetchJson(copilotUrls(domain).copilotTokenUrl, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${refreshToken}`,
      ...COPILOT_STATIC_HEADERS,
    },
    signal,
  })) as Record<string, unknown>;

  const token = raw.token;
  const expiresAt = raw.expires_at;
  if (typeof token !== "string" || typeof expiresAt !== "number") {
    throw new Error(`Invalid Copilot token response: ${JSON.stringify(raw).slice(0, 300)}`);
  }
  return {
    access: token,
    expiresAtSeconds: expiresAt,
    baseUrl: copilotBaseUrl(token, enterpriseDomain),
  };
}

export function isFresh(credential: CopilotCredential | null): boolean {
  return credential !== null && typeof credential.access === "string" && credential.expires > Date.now();
}

/** 刷新后的凭据（不含模型列表；模型列表只在登录/设置时更新）。 */
export async function refreshCredential(
  credential: CopilotCredential,
  signal?: AbortSignal,
): Promise<CopilotCredential> {
  const exchanged = await exchangeCopilotToken(credential.refresh, credential.enterpriseDomain, signal);
  return {
    ...credential,
    access: exchanged.access,
    expires: exchanged.expiresAtSeconds * 1000 - REFRESH_LEEWAY_MS,
  };
}
