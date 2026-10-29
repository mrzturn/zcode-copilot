/**
 * GitHub Copilot 常量与共享工具。
 * 协议细节照搬 pi（badlogic/pi-mono packages/ai）的 GitHub Copilot 接入实现，
 * client_id 为 VS Code Copilot Chat 扩展公开的 OAuth App。
 */

export const GITHUB_COPILOT_CLIENT_ID = "Iv1.b507a08c87ecfe98";

export const COPILOT_USER_AGENT = "GitHubCopilotChat/0.35.0";

/** 与 Copilot 服务端握手的身份头，缺失会被拒绝。 */
export const COPILOT_STATIC_HEADERS: Readonly<Record<string, string>> = {
  "User-Agent": COPILOT_USER_AGENT,
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat",
};

export const COPILOT_API_VERSION = "2026-06-01";
export const DEFAULT_COPILOT_BASE_URL = "https://api.individual.githubcopilot.com";
export const DEFAULT_PROXY_PORT = 48911;

export function proxyPort(): number {
  const parsed = Number.parseInt(process.env.ZCODE_COPILOT_PORT ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : DEFAULT_PROXY_PORT;
}

export function proxyBaseUrl(): string {
  return `http://127.0.0.1:${proxyPort()}`;
}

export function copilotUrls(domain: string): {
  deviceCodeUrl: string;
  accessTokenUrl: string;
  copilotTokenUrl: string;
} {
  return {
    deviceCodeUrl: `https://${domain}/login/device/code`,
    accessTokenUrl: `https://${domain}/login/oauth/access_token`,
    copilotTokenUrl: `https://api.${domain}/copilot_internal/v2/token`,
  };
}

/**
 * Copilot token 内嵌 `proxy-ep=proxy.xxx` 端点，按账号类型指向不同 API 主机
 * （individual / business / enterprise）。proxy. 前缀换成 api. 即 API base URL。
 */
export function baseUrlFromCopilotToken(token: string): string | null {
  const match = /proxy-ep=([^;]+)/.exec(token);
  if (!match?.[1]) return null;
  return `https://${match[1]!.replace(/^proxy\./, "api.")}`;
}

export function copilotBaseUrl(token?: string, enterpriseDomain?: string): string {
  if (token) {
    const fromToken = baseUrlFromCopilotToken(token);
    if (fromToken) return fromToken;
  }
  if (enterpriseDomain) return `https://copilot-api.${enterpriseDomain}`;
  return DEFAULT_COPILOT_BASE_URL;
}

export async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
  }
  return response.json();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
