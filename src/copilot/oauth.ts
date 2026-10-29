/**
 * GitHub 设备码 OAuth 流程（RFC 8628），用于获取长期有效的 GitHub 用户令牌（ghu_…）。
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { COPILOT_USER_AGENT, GITHUB_COPILOT_CLIENT_ID, copilotUrls, fetchJson, sleep } from "./constants.ts";

const execAsync = promisify(exec);

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  intervalSeconds: number;
  expiresInSeconds: number;
}

export type DeviceFlowEvent =
  | { status: "pending" }
  | { status: "complete"; githubAccessToken: string }
  | { status: "failed"; message: string };

export async function startDeviceFlow(domain = "github.com", signal?: AbortSignal): Promise<DeviceCode> {
  const urls = copilotUrls(domain);
  const data = (await fetchJson(urls.deviceCodeUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": COPILOT_USER_AGENT,
    },
    body: new URLSearchParams({ client_id: GITHUB_COPILOT_CLIENT_ID, scope: "read:user" }),
    signal,
  })) as Record<string, unknown>;

  const { device_code, user_code, verification_uri, interval, expires_in } = data;
  if (
    typeof device_code !== "string" ||
    typeof user_code !== "string" ||
    typeof verification_uri !== "string" ||
    typeof expires_in !== "number"
  ) {
    throw new Error(`Invalid device code response: ${JSON.stringify(data).slice(0, 300)}`);
  }
  let verificationUri = verification_uri;
  try {
    const parsed = new URL(verification_uri);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("bad protocol");
    }
    verificationUri = parsed.toString();
  } catch {
    throw new Error(`Untrusted verification_uri: ${verification_uri}`);
  }
  return {
    deviceCode: device_code,
    userCode: user_code,
    verificationUri,
    intervalSeconds: typeof interval === "number" ? interval : 5,
    expiresInSeconds: expires_in,
  };
}

/** 轮询一次设备码授权状态。 */
export async function pollDeviceFlowOnce(
  domain: string,
  device: DeviceCode,
  signal?: AbortSignal,
): Promise<DeviceFlowEvent> {
  const urls = copilotUrls(domain);
  let raw: unknown;
  try {
    raw = await fetchJson(urls.accessTokenUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": COPILOT_USER_AGENT,
      },
      body: new URLSearchParams({
        client_id: GITHUB_COPILOT_CLIENT_ID,
        device_code: device.deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
      signal,
    });
  } catch (error) {
    // 网络抖动按 pending 处理，交给上层重试。
    if (signal?.aborted) throw error;
    return { status: "pending" };
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.access_token === "string") {
    return { status: "complete", githubAccessToken: record.access_token };
  }
  if (typeof record.error === "string") {
    if (record.error === "authorization_pending") return { status: "pending" };
    if (record.error === "slow_down") {
      return { status: "pending" };
    }
    const description = typeof record.error_description === "string" ? `: ${record.error_description}` : "";
    return { status: "failed", message: `Device flow failed: ${record.error}${description}` };
  }
  return { status: "failed", message: "Invalid device token response" };
}

/**
 * 完整轮询循环：按 interval 轮询直到授权完成 / 失败 / 过期。
 * slow_down 时 GitHub 会返回更大的 interval，这里简单地在超时前逐步放宽。
 */
export async function pollForGitHubAccessToken(
  domain: string,
  device: DeviceCode,
  options: { signal?: AbortSignal; onTick?: () => void } = {},
): Promise<string> {
  const deadline = Date.now() + device.expiresInSeconds * 1000;
  let intervalMs = device.intervalSeconds * 1000;
  // RFC 8628：发起后先等一个 interval 再首次轮询。
  await sleep(intervalMs);
  while (Date.now() < deadline) {
    options.onTick?.();
    const event = await pollDeviceFlowOnce(domain, device, options.signal);
    if (event.status === "complete") return event.githubAccessToken;
    if (event.status === "failed") throw new Error(event.message);
    await sleep(intervalMs);
    // 授权页一般在几分钟内完成；轮次变多后适度放缓。
    if (intervalMs < 10000) intervalMs = Math.min(10000, intervalMs + 1000);
  }
  throw new Error("Device code expired before authorization completed");
}

/** 尽力打开浏览器（跨平台，失败静默）。 */
export async function openBrowser(url: string): Promise<boolean> {
  const command =
    process.platform === "darwin" ? `open "${url}"` : process.platform === "win32" ? `start "" "${url}"` : `xdg-open "${url}"`;
  try {
    await execAsync(command, { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/** 尽力复制到剪贴板（跨平台，失败静默）。 */
export async function copyToClipboard(text: string): Promise<boolean> {
  const command =
    process.platform === "darwin" ? "pbcopy" : process.platform === "win32" ? "clip" : "xclip -selection clipboard";
  try {
    await execAsync(command, { input: text, timeout: 3000 } as never);
    return true;
  } catch {
    return false;
  }
}
