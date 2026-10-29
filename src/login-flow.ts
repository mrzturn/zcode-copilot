/**
 * GitHub Copilot 登录流程（MCP 与 CLI 共用）。
 *
 * beginLogin() 立即返回设备码信息并自动打开浏览器/复制验证码；
 * 后台任务轮询授权 → 换取 Copilot 令牌 → 拉取模型 → 启用未配置模型 → 落盘。
 * loginState() 供轮询查询；waitForLogin() 供 CLI 阻塞等待。
 */

import { deleteCredential, readCredential, writeCredential } from "./store.ts";
import { exchangeCopilotToken, type CopilotCredential } from "./copilot/token.ts";
import { enableCopilotModels, fetchCopilotModels } from "./copilot/models.ts";
import { openBrowser, copyToClipboard, pollForGitHubAccessToken, startDeviceFlow } from "./copilot/oauth.ts";
import { modelFamily } from "./catalog.ts";

export interface LoginState {
  status: "idle" | "pending" | "complete" | "failed";
  userCode?: string;
  verificationUri?: string;
  startedAt?: number;
  expiresInSeconds?: number;
  error?: string;
  modelCount?: number;
}

let state: LoginState = { status: "idle" };
let completers: Array<() => void> = [];

function notifyCompleters(): void {
  const pending = completers;
  completers = [];
  for (const resolve of pending) resolve();
}

export function loginState(): LoginState {
  return { ...state };
}

export function waitForLogin(): Promise<void> {
  if (state.status !== "pending") return Promise.resolve();
  return new Promise((resolve) => completers.push(resolve));
}

/** 值得 policy enable 的未配置模型：已知家族（claude / responses）+ kimi-k3。 */
function isEnableCandidate(modelId: string): boolean {
  const family = modelFamily(modelId);
  return family === "claude" || family === "responses" || modelId === "kimi-k3";
}

async function completeLoginInBackground(device: Awaited<ReturnType<typeof startDeviceFlow>>): Promise<void> {
  try {
    const githubAccessToken = await pollForGitHubAccessToken("github.com", device);
    const exchanged = await exchangeCopilotToken(githubAccessToken);
    const catalog = await fetchCopilotModels(exchanged.access);
    const enableTargets = catalog.policyModelIds.filter(isEnableCandidate);
    const enabledIds = enableTargets.length > 0 ? await enableCopilotModels(exchanged.access, enableTargets) : [];
    const availableModelIds = [...new Set([...catalog.availableModelIds, ...enabledIds])];
    const credential: CopilotCredential = {
      refresh: githubAccessToken,
      access: exchanged.access,
      expires: exchanged.expiresAtSeconds * 1000 - 5 * 60 * 1000,
      availableModelIds,
    };
    await writeCredential(credential);
    state = { ...state, status: "complete", modelCount: availableModelIds.length };
  } catch (error) {
    state = {
      ...state,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    notifyCompleters();
  }
}

export interface BeginLoginResult {
  alreadyLoggedIn: boolean;
  userCode?: string;
  verificationUri?: string;
  browserOpened?: boolean;
  clipboardCopied?: boolean;
}

export async function beginLogin(): Promise<BeginLoginResult> {
  const existing = await readCredential();
  if (existing?.refresh) {
    return { alreadyLoggedIn: true };
  }
  if (state.status === "pending") {
    return {
      alreadyLoggedIn: false,
      userCode: state.userCode,
      verificationUri: state.verificationUri,
    };
  }
  const device = await startDeviceFlow("github.com");
  state = {
    status: "pending",
    userCode: device.userCode,
    verificationUri: device.verificationUri,
    startedAt: Date.now(),
    expiresInSeconds: device.expiresInSeconds,
  };
  const browserOpened = await openBrowser(device.verificationUri);
  const clipboardCopied = await copyToClipboard(device.userCode);
  void completeLoginInBackground(device);
  return {
    alreadyLoggedIn: false,
    userCode: device.userCode,
    verificationUri: device.verificationUri,
    browserOpened,
    clipboardCopied,
  };
}

export async function logout(): Promise<boolean> {
  await deleteCredential();
  state = { status: "idle" };
  return true;
}
