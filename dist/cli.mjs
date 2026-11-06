// src/copilot/constants.ts
var GITHUB_COPILOT_CLIENT_ID = "Iv1.b507a08c87ecfe98";
var COPILOT_USER_AGENT = "GitHubCopilotChat/0.35.0";
var COPILOT_STATIC_HEADERS = {
  "User-Agent": COPILOT_USER_AGENT,
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat"
};
var COPILOT_API_VERSION = "2026-06-01";
var DEFAULT_COPILOT_BASE_URL = "https://api.individual.githubcopilot.com";
var DEFAULT_PROXY_PORT = 48911;
function proxyPort() {
  const parsed = Number.parseInt(process.env.ZCODE_COPILOT_PORT ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : DEFAULT_PROXY_PORT;
}
function proxyBaseUrl() {
  return `http://127.0.0.1:${proxyPort()}`;
}
function copilotUrls(domain) {
  return {
    deviceCodeUrl: `https://${domain}/login/device/code`,
    accessTokenUrl: `https://${domain}/login/oauth/access_token`,
    copilotTokenUrl: `https://api.${domain}/copilot_internal/v2/token`
  };
}
function baseUrlFromCopilotToken(token) {
  const match = /proxy-ep=([^;]+)/.exec(token);
  if (!match?.[1]) return null;
  return `https://${match[1].replace(/^proxy\./, "api.")}`;
}
function copilotBaseUrl(token, enterpriseDomain) {
  if (token) {
    const fromToken = baseUrlFromCopilotToken(token);
    if (fromToken) return fromToken;
  }
  if (enterpriseDomain) return `https://copilot-api.${enterpriseDomain}`;
  return DEFAULT_COPILOT_BASE_URL;
}
async function fetchJson(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
  }
  return response.json();
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// src/daemon-manage.ts
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname as dirname2, join as join2 } from "node:path";
import { readFile as readFile2, rm as rm2 } from "node:fs/promises";

// src/store.ts
import { chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
function pluginDataDir() {
  return process.env.ZCODE_COPILOT_HOME?.trim() || join(homedir(), ".zcode-copilot");
}
function authFilePath() {
  return join(pluginDataDir(), "auth.json");
}
function daemonMetaPath() {
  return join(pluginDataDir(), "daemon.json");
}
var writeChain = Promise.resolve();
async function readCredential() {
  try {
    const text = await readFile(authFilePath(), "utf-8");
    const parsed = JSON.parse(text);
    if (typeof parsed.refresh !== "string" || typeof parsed.access !== "string") return null;
    return {
      refresh: parsed.refresh,
      access: parsed.access,
      expires: typeof parsed.expires === "number" ? parsed.expires : 0,
      enterpriseDomain: typeof parsed.enterpriseDomain === "string" ? parsed.enterpriseDomain : void 0,
      availableModelIds: Array.isArray(parsed.availableModelIds) ? parsed.availableModelIds.filter((id) => typeof id === "string") : void 0
    };
  } catch {
    return null;
  }
}
async function writeCredential(credential) {
  const run = writeChain.then(async () => {
    const filePath = authFilePath();
    await mkdir(dirname(filePath), { recursive: true });
    const tempPath = join(
      dirname(filePath),
      `.${basename(filePath)}.${process.pid}.${Date.now()}.tmp`
    );
    await writeFile(tempPath, JSON.stringify(credential, null, 2) + "\n", { encoding: "utf-8", mode: 384 });
    try {
      await rename(tempPath, filePath);
      await chmod(filePath, 384).catch(() => void 0);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => void 0);
      throw error;
    }
  });
  writeChain = run.catch(() => void 0);
  await run;
}
async function deleteCredential() {
  try {
    await rm(authFilePath(), { force: true });
    return true;
  } catch {
    return false;
  }
}
async function importFromPiIfAvailable() {
  const existing = await readCredential();
  if (existing) return { imported: false, reason: "already logged in" };
  const piAuthPath = join(homedir(), ".pi", "agent", "auth.json");
  let parsed;
  try {
    parsed = JSON.parse(await readFile(piAuthPath, "utf-8"));
  } catch {
    return { imported: false, reason: "no pi credential found" };
  }
  const copilot = parsed["github-copilot"];
  const refresh = copilot?.refresh;
  if (typeof refresh !== "string" || !refresh) {
    return { imported: false, reason: "pi has no github-copilot credential" };
  }
  await writeCredential({
    refresh,
    access: typeof copilot?.access === "string" ? copilot.access : "",
    expires: typeof copilot?.expires === "number" ? copilot.expires : 0,
    enterpriseDomain: typeof copilot?.enterpriseUrl === "string" && copilot.enterpriseUrl ? copilot.enterpriseUrl : void 0,
    availableModelIds: void 0
  });
  return { imported: true };
}

// src/daemon-manage.ts
async function checkDaemon(timeoutMs = 1200) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${proxyBaseUrl()}/health`, { signal: controller.signal });
    if (!response.ok) return { ok: false };
    const payload = await response.json();
    let pid;
    try {
      const meta = JSON.parse(await readFile2(daemonMetaPath(), "utf-8"));
      if (typeof meta.pid === "number") pid = meta.pid;
    } catch {
    }
    return {
      ok: true,
      loggedIn: payload.loggedIn === true,
      expiresAt: typeof payload.expiresAt === "number" ? payload.expiresAt : void 0,
      baseUrl: typeof payload.baseUrl === "string" ? payload.baseUrl : void 0,
      pid
    };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}
function daemonScriptPath() {
  return join2(dirname2(fileURLToPath(import.meta.url)), "daemon.mjs");
}
async function ensureDaemon(options = {}) {
  const existing = await checkDaemon();
  if (existing.ok) return existing;
  const child = spawn(process.execPath, [daemonScriptPath()], {
    env: { ...process.env, ZCODE_COPILOT_PORT: String(proxyPort()) },
    stdio: "ignore",
    detached: true
  });
  child.unref();
  const deadline = Date.now() + (options.waitMs ?? 6e3);
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const health = await checkDaemon(600);
    if (health.ok) return health;
  }
  throw new Error(
    `Copilot \u4EE3\u7406 daemon \u542F\u52A8\u5931\u8D25\uFF08\u7AEF\u53E3 ${proxyPort()}\uFF09\u3002\u53EF\u624B\u52A8\u8FD0\u884C\u6392\u67E5\uFF1Anode ${daemonScriptPath()}`
  );
}
async function stopDaemon() {
  const health = await checkDaemon(600);
  if (!health.ok) return { stopped: false, note: "daemon not running" };
  let pid = health.pid;
  if (!pid) {
    try {
      const meta = JSON.parse(await readFile2(daemonMetaPath(), "utf-8"));
      if (typeof meta.pid === "number") pid = meta.pid;
    } catch {
    }
  }
  if (!pid) return { stopped: false, note: "daemon running but pid unknown" };
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") {
      return { stopped: false, note: `failed to signal pid ${pid}` };
    }
  }
  await rm2(daemonMetaPath(), { force: true }).catch(() => void 0);
  return { stopped: true };
}

// src/copilot/token.ts
var REFRESH_LEEWAY_MS = 5 * 60 * 1e3;
async function exchangeCopilotToken(refreshToken, enterpriseDomain, signal) {
  const domain = enterpriseDomain || "github.com";
  const raw = await fetchJson(copilotUrls(domain).copilotTokenUrl, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${refreshToken}`,
      ...COPILOT_STATIC_HEADERS
    },
    signal
  });
  const token = raw.token;
  const expiresAt = raw.expires_at;
  if (typeof token !== "string" || typeof expiresAt !== "number") {
    throw new Error(`Invalid Copilot token response: ${JSON.stringify(raw).slice(0, 300)}`);
  }
  return {
    access: token,
    expiresAtSeconds: expiresAt,
    baseUrl: copilotBaseUrl(token, enterpriseDomain)
  };
}
function isFresh(credential) {
  return credential !== null && typeof credential.access === "string" && credential.expires > Date.now();
}
async function refreshCredential(credential, signal) {
  const exchanged = await exchangeCopilotToken(credential.refresh, credential.enterpriseDomain, signal);
  return {
    ...credential,
    access: exchanged.access,
    expires: exchanged.expiresAtSeconds * 1e3 - REFRESH_LEEWAY_MS
  };
}

// src/copilot/models.ts
function asRecord(value) {
  return value && typeof value === "object" ? value : void 0;
}
function readPositiveInt(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : void 0;
}
function parseCopilotModelCatalog(raw, allowPolicyFallback) {
  const data = asRecord(raw)?.data;
  if (!Array.isArray(data)) throw new Error("Invalid Copilot models response");
  const models = [];
  for (const rawItem of data) {
    const item = asRecord(rawItem);
    const id = item?.id;
    if (!item || typeof id !== "string") continue;
    const capabilities = asRecord(item.capabilities);
    const supports = asRecord(capabilities?.supports);
    if (supports?.tool_calls === false) continue;
    const limits = asRecord(capabilities?.limits);
    const reasoningEfforts = Array.isArray(supports?.reasoning_effort) ? supports.reasoning_effort.filter((v) => typeof v === "string" && v.length > 0) : void 0;
    const visionMedia = asRecord(limits?.vision);
    const supportedMediaTypes = Array.isArray(visionMedia?.supported_media_types) ? visionMedia.supported_media_types.filter((v) => typeof v === "string") : [];
    const vision = supports?.vision === true;
    const contextWindow = readPositiveInt(limits?.max_context_window_tokens);
    const maxOutputTokens = readPositiveInt(limits?.max_output_tokens);
    models.push({
      id,
      pickerEnabled: item.model_picker_enabled === true,
      policyState: asRecord(item.policy)?.state,
      supportsToolCalls: supports?.tool_calls !== false,
      reasoningEfforts: reasoningEfforts && reasoningEfforts.length > 0 ? reasoningEfforts : void 0,
      contextWindow,
      maxOutputTokens,
      vision,
      pdf: vision && supportedMediaTypes.includes("application/pdf"),
      name: typeof item.name === "string" ? item.name : void 0,
      vendor: typeof item.vendor === "string" ? item.vendor : void 0
    });
  }
  const pickerModelIds = models.filter((m) => m.pickerEnabled && m.policyState !== "disabled").map((m) => m.id);
  const usePolicyFallback = allowPolicyFallback && pickerModelIds.length === 0;
  const availableModelIds = pickerModelIds.length > 0 || !allowPolicyFallback ? pickerModelIds : models.filter((m) => m.policyState === "enabled").map((m) => m.id);
  const policyModelIds = models.filter((m) => m.policyState === "unconfigured" && (m.pickerEnabled || usePolicyFallback)).map((m) => m.id);
  return { models, availableModelIds, policyModelIds };
}
async function fetchCopilotModels(copilotToken, enterpriseDomain, signal) {
  const baseUrl = copilotBaseUrl(copilotToken, enterpriseDomain);
  const allowPolicyFallback = baseUrl === "https://api.individual.githubcopilot.com";
  const response = await fetchWithRateLimitRetry(
    `${baseUrl}/models`,
    {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${copilotToken}`,
        ...COPILOT_STATIC_HEADERS,
        "X-GitHub-Api-Version": COPILOT_API_VERSION
      },
      signal
    },
    { maxRetries: 2, maxElapsedMs: 8e3 }
  );
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${(await response.text()).slice(0, 300)}`);
  }
  return parseCopilotModelCatalog(await response.json(), allowPolicyFallback);
}
async function fetchWithRateLimitRetry(url, init, retryPolicy) {
  for (let retry = 0; ; retry++) {
    const response = await fetch(url, { ...init, signal: init.signal });
    if (response.status !== 429 || retry >= retryPolicy.maxRetries) return response;
    const retryAfter = response.headers.get("retry-after");
    let delayMs = 500 * 2 ** retry;
    if (retryAfter) {
      const seconds = Number.parseFloat(retryAfter);
      delayMs = Number.isNaN(seconds) ? Date.parse(retryAfter) - Date.now() : seconds * 1e3;
      if (!Number.isFinite(delayMs)) return response;
    }
    if (Date.now() + Math.max(0, delayMs) >= Date.now() + retryPolicy.maxElapsedMs) return response;
    await sleep(Math.max(0, delayMs));
  }
}
async function enableCopilotModel(copilotToken, modelId, enterpriseDomain) {
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
          "x-interaction-type": "chat-policy"
        },
        body: JSON.stringify({ state: "enabled" })
      },
      { maxRetries: 2, maxElapsedMs: 5e3 }
    );
    return response.ok;
  } catch {
    return false;
  }
}
async function enableCopilotModels(copilotToken, modelIds, enterpriseDomain) {
  const enabled = [];
  for (const modelId of modelIds) {
    if (await enableCopilotModel(copilotToken, modelId, enterpriseDomain)) {
      enabled.push(modelId);
    }
  }
  return enabled;
}

// src/copilot/oauth.ts
import { exec } from "node:child_process";
import { promisify } from "node:util";
var execAsync = promisify(exec);
async function startDeviceFlow(domain = "github.com", signal) {
  const urls = copilotUrls(domain);
  const data = await fetchJson(urls.deviceCodeUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": COPILOT_USER_AGENT
    },
    body: new URLSearchParams({ client_id: GITHUB_COPILOT_CLIENT_ID, scope: "read:user" }),
    signal
  });
  const { device_code, user_code, verification_uri, interval, expires_in } = data;
  if (typeof device_code !== "string" || typeof user_code !== "string" || typeof verification_uri !== "string" || typeof expires_in !== "number") {
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
    expiresInSeconds: expires_in
  };
}
async function pollDeviceFlowOnce(domain, device, signal) {
  const urls = copilotUrls(domain);
  let raw;
  try {
    raw = await fetchJson(urls.accessTokenUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": COPILOT_USER_AGENT
      },
      body: new URLSearchParams({
        client_id: GITHUB_COPILOT_CLIENT_ID,
        device_code: device.deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code"
      }),
      signal
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    return { status: "pending" };
  }
  const record = raw;
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
async function pollForGitHubAccessToken(domain, device, options = {}) {
  const deadline = Date.now() + device.expiresInSeconds * 1e3;
  let intervalMs = device.intervalSeconds * 1e3;
  await sleep(intervalMs);
  while (Date.now() < deadline) {
    options.onTick?.();
    const event = await pollDeviceFlowOnce(domain, device, options.signal);
    if (event.status === "complete") return event.githubAccessToken;
    if (event.status === "failed") throw new Error(event.message);
    await sleep(intervalMs);
    if (intervalMs < 1e4) intervalMs = Math.min(1e4, intervalMs + 1e3);
  }
  throw new Error("Device code expired before authorization completed");
}
async function openBrowser(url) {
  const command = process.platform === "darwin" ? `open "${url}"` : process.platform === "win32" ? `start "" "${url}"` : `xdg-open "${url}"`;
  try {
    await execAsync(command, { timeout: 3e3 });
    return true;
  } catch {
    return false;
  }
}
async function copyToClipboard(text) {
  const command = process.platform === "darwin" ? "pbcopy" : process.platform === "win32" ? "clip" : "xclip -selection clipboard";
  try {
    await execAsync(command, { input: text, timeout: 3e3 });
    return true;
  } catch {
    return false;
  }
}

// src/catalog.ts
function modelFamily(modelId) {
  if (/^claude-(haiku|sonnet|opus|fable)-[45]([.-]|$)/.test(modelId)) return "claude";
  if (/^(gpt-|grok-|oswe|mai-)/.test(modelId)) return "responses";
  return "completions";
}
var STATIC_REASONING_FALLBACK = {
  claude: ["low", "medium", "high"],
  gpt: ["low", "medium", "high"],
  grok: ["low", "medium", "high", "xhigh"],
  completions: []
};
var EXTENDED_CONTEXT_MODEL_IDS = /* @__PURE__ */ new Set([
  "claude-fable-5",
  "claude-opus-4.8",
  "claude-opus-5",
  "claude-opus-5.5",
  "claude-sonnet-4.6",
  "claude-sonnet-5",
  "gpt-5.3-codex",
  "gpt-6-astra",
  "gpt-6-luna",
  "gpt-6-sol"
]);
function contextWindowFor(modelId, family) {
  if (EXTENDED_CONTEXT_MODEL_IDS.has(modelId)) return 1e6;
  if (family === "claude") return 2e5;
  if (/^gpt-[56]/.test(modelId)) return 4e5;
  if (/^grok-/.test(modelId)) return 5e5;
  return 128e3;
}
function maxOutputTokensFor(modelId, family) {
  if (family === "claude") return 64e3;
  if (/^gpt-[56]/.test(modelId) || /^grok-/.test(modelId)) return 128e3;
  return 32768;
}
function reasoningMap(family, offType, hasEfforts) {
  if (!hasEfforts) return "{}";
  if (family === "claude") {
    const offValue = offType === "between_tools" ? '{"thinking": {"type": "between_tools"}}' : offType === "disabled" ? '{"thinking": {"type": "disabled"}}' : "{}";
    return [
      'reasoningLevel == "disabled"',
      `? ${offValue}`,
      ': {"thinking": {"type": "adaptive"}, "output_config": {"effort": reasoningLevel}}'
    ].join(" ");
  }
  if (family === "responses") return '{"reasoning": {"effort": reasoningLevel, "summary": "auto"}}';
  return '{"reasoning_effort": reasoningLevel}';
}
function maxOutputTokensMap(family) {
  if (family === "claude") return "{'max_tokens': maxOutputTokens}";
  if (family === "responses") return "{'max_output_tokens': maxOutputTokens}";
  return "{'max_completion_tokens': maxOutputTokens}";
}
function buildModelConfig(model, offType) {
  const family = modelFamily(model.id);
  const efforts = model.degraded ? family === "claude" ? STATIC_REASONING_FALLBACK.claude : family === "responses" ? /^grok-/.test(model.id) ? STATIC_REASONING_FALLBACK.grok : STATIC_REASONING_FALLBACK.gpt : STATIC_REASONING_FALLBACK.completions : model.reasoningEfforts ?? [];
  const values = family === "claude" ? ["disabled", ...efforts] : [...efforts];
  const vision = model.vision ?? (family === "claude" || /^gpt-[56]/.test(model.id) || /^grok-/.test(model.id));
  const contextWindow = model.contextWindow ?? contextWindowFor(model.id, family);
  const maxOutputTokens = model.maxOutputTokens ?? maxOutputTokensFor(model.id, family);
  return {
    enabled: true,
    properties: {
      contextWindow,
      inputFormat: {
        supportsText: true,
        supportsImage: vision,
        supportsVideo: false,
        supportsAudio: false,
        supportsPdf: model.pdf === true
      },
      outputFormat: { supportsText: true },
      supportsToolCall: true,
      supportsJsonSchemaOutput: false,
      supportsNativeWebSearch: false,
      // pi 验证过 Copilot 对 claude / openai 家族可透传 mid-conversation system。
      supportsMidConversationSystem: family !== "completions" || model.id === "kimi-k3"
    },
    optionSpecs: {
      reasoningLevel: {
        values,
        map: reasoningMap(family, offType, values.length > 0 && !(values.length === 1 && values[0] === "disabled"))
      },
      maxOutputTokens: { max: maxOutputTokens, map: maxOutputTokensMap(family) }
    }
  };
}
function buildProviderPlans(availableModels, offTypes = /* @__PURE__ */ new Map()) {
  const byFamily = /* @__PURE__ */ new Map();
  for (const model of availableModels) {
    const family = modelFamily(model.id);
    const list = byFamily.get(family) ?? [];
    list.push(model);
    byFamily.set(family, list);
  }
  const toPlan = (family, providerId, providerName, apiType, baseUrl) => ({
    providerId,
    providerName,
    apiType,
    baseUrl,
    models: (byFamily.get(family) ?? []).map((model) => ({
      modelId: model.id,
      config: buildModelConfig(model, offTypes.get(model.id) ?? "disabled")
    }))
  });
  const base = proxyBaseUrl();
  const plans = [];
  if ((byFamily.get("claude") ?? []).length > 0) {
    plans.push(toPlan("claude", "copilot-claude", "GitHub Copilot (Claude)", "anthropic-messages", base));
  }
  if ((byFamily.get("responses") ?? []).length > 0) {
    plans.push(toPlan("responses", "copilot-gpt", "GitHub Copilot (GPT/Grok)", "openai-responses", `${base}/v1`));
  }
  if ((byFamily.get("completions") ?? []).length > 0) {
    plans.push(toPlan("completions", "copilot-openai", "GitHub Copilot (OpenAI Chat)", "openai-chat-completions", `${base}/v1`));
  }
  return plans;
}

// src/login-flow.ts
var state = { status: "idle" };
var completers = [];
function notifyCompleters() {
  const pending = completers;
  completers = [];
  for (const resolve of pending) resolve();
}
function loginState() {
  return { ...state };
}
function waitForLogin() {
  if (state.status !== "pending") return Promise.resolve();
  return new Promise((resolve) => completers.push(resolve));
}
function isEnableCandidate(modelId) {
  const family = modelFamily(modelId);
  return family === "claude" || family === "responses" || modelId === "kimi-k3";
}
async function completeLoginInBackground(device) {
  try {
    const githubAccessToken = await pollForGitHubAccessToken("github.com", device);
    const exchanged = await exchangeCopilotToken(githubAccessToken);
    const catalog = await fetchCopilotModels(exchanged.access);
    const enableTargets = catalog.policyModelIds.filter(isEnableCandidate);
    const enabledIds = enableTargets.length > 0 ? await enableCopilotModels(exchanged.access, enableTargets) : [];
    const availableModelIds = [.../* @__PURE__ */ new Set([...catalog.availableModelIds, ...enabledIds])];
    const credential = {
      refresh: githubAccessToken,
      access: exchanged.access,
      expires: exchanged.expiresAtSeconds * 1e3 - 5 * 60 * 1e3,
      availableModelIds
    };
    await writeCredential(credential);
    state = { ...state, status: "complete", modelCount: availableModelIds.length };
  } catch (error) {
    state = {
      ...state,
      status: "failed",
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    notifyCompleters();
  }
}
async function beginLogin() {
  const existing = await readCredential();
  if (existing?.refresh) {
    return { alreadyLoggedIn: true };
  }
  if (state.status === "pending") {
    return {
      alreadyLoggedIn: false,
      userCode: state.userCode,
      verificationUri: state.verificationUri
    };
  }
  const device = await startDeviceFlow("github.com");
  state = {
    status: "pending",
    userCode: device.userCode,
    verificationUri: device.verificationUri,
    startedAt: Date.now(),
    expiresInSeconds: device.expiresInSeconds
  };
  const browserOpened = await openBrowser(device.verificationUri);
  const clipboardCopied = await copyToClipboard(device.userCode);
  void completeLoginInBackground(device);
  return {
    alreadyLoggedIn: false,
    userCode: device.userCode,
    verificationUri: device.verificationUri,
    browserOpened,
    clipboardCopied
  };
}
async function logout() {
  await deleteCredential();
  state = { status: "idle" };
  return true;
}

// src/token-manager.ts
var NotLoggedInError = class extends Error {
  constructor() {
    super(
      "GitHub Copilot \u672A\u767B\u5F55\u3002\u8BF7\u5148\u8C03\u7528 copilot_login \u5DE5\u5177\uFF08\u6216\u8FD0\u884C `node dist/cli.mjs login`\uFF09\u5B8C\u6210\u8BBE\u5907\u7801\u767B\u5F55\u3002"
    );
    this.name = "NotLoggedInError";
  }
};
var refreshInFlight = null;
async function ensureFreshCredential() {
  const credential = await readCredential();
  if (!credential?.refresh) throw new NotLoggedInError();
  if (isFresh(credential)) return credential;
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      const current = await readCredential() ?? credential;
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
async function credentialStatus() {
  const credential = await readCredential();
  if (!credential?.refresh) return { loggedIn: false };
  return {
    loggedIn: true,
    expiresAt: credential.expires,
    baseUrl: credential.access ? copilotBaseUrl(credential.access, credential.enterpriseDomain) : void 0,
    availableModelCount: credential.availableModelIds?.length ?? 0
  };
}

// src/reasoning-probe.ts
async function postThinkingOff(baseUrl, token, modelId, type) {
  try {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...COPILOT_STATIC_HEADERS
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
        thinking: { type }
      }),
      signal: AbortSignal.timeout(15e3)
    });
    return response.status === 200;
  } catch {
    return false;
  }
}
async function detectClaudeOffType(copilotToken, baseUrl, modelId) {
  if (await postThinkingOff(baseUrl, copilotToken, modelId, "between_tools")) return "between_tools";
  if (await postThinkingOff(baseUrl, copilotToken, modelId, "disabled")) return "disabled";
  return "omit";
}

// src/zcode-config.ts
import { mkdir as mkdir2, readFile as readFile3, readdir, rename as rename2, rm as rm3, rmdir, stat, writeFile as writeFile2 } from "node:fs/promises";
import { basename as basename2, dirname as dirname3, join as join3 } from "node:path";
import { homedir as homedir2 } from "node:os";
var COPILOT_PROVIDER_IDS = ["copilot-claude", "copilot-gpt", "copilot-openai"];
function providerConfigPath() {
  return process.env.ZCODE_PROVIDER_CONFIG_FILE?.trim() || join3(homedir2(), ".zcode", "v2", "provider_config.json");
}
var lockChain = Promise.resolve();
async function acquireZcodeLock(filePath) {
  const lockDir = `${filePath}.lock`;
  const token = `${process.pid}-${Math.random().toString(16).slice(2)}`;
  const ownerPath = join3(lockDir, `owner-${token}.json`);
  const deadline = Date.now() + 8e3;
  for (; ; ) {
    try {
      await mkdir2(lockDir, { recursive: false });
      await writeFile2(ownerPath, JSON.stringify({ pid: process.pid, createdAt: Date.now() }) + "\n", "utf-8");
      return {
        release: async () => {
          await rm3(ownerPath, { force: true }).catch(() => void 0);
          await rmdir(lockDir).catch(() => void 0);
        }
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const reclaimed = await tryReclaimStaleLock(lockDir);
    if (reclaimed) continue;
    if (Date.now() > deadline) {
      throw new Error("\u7B49\u5F85 provider_config.json \u6587\u4EF6\u9501\u8D85\u65F6\uFF08ZCode \u53EF\u80FD\u6B63\u5728\u5199\u5165\uFF09\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5");
    }
    await sleep(120);
  }
}
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}
async function tryReclaimStaleLock(lockDir) {
  let entries;
  try {
    entries = await readdir(lockDir);
  } catch {
    return true;
  }
  const owners = entries.filter((entry) => entry.startsWith("owner-") && entry.endsWith(".json"));
  if (owners.length === 0) {
    try {
      const info = await stat(lockDir);
      if (Date.now() - info.mtimeMs > 1e4) {
        await rmdir(lockDir).catch(() => void 0);
        return true;
      }
    } catch {
    }
    return false;
  }
  for (const owner of owners) {
    const ownerPath = join3(lockDir, owner);
    try {
      const meta = JSON.parse(await readFile3(ownerPath, "utf-8"));
      const pid = typeof meta.pid === "number" && Number.isSafeInteger(meta.pid) && meta.pid > 0 ? meta.pid : null;
      const createdAt = typeof meta.createdAt === "number" ? meta.createdAt : null;
      if (pid !== null && isProcessAlive(pid) && createdAt !== null && Date.now() - createdAt < 3e4) {
        return false;
      }
    } catch {
    }
    await rm3(ownerPath, { force: true }).catch(() => void 0);
  }
  return true;
}
async function readProviderConfigFile(filePath) {
  let text;
  try {
    text = await readFile3(filePath, "utf-8");
  } catch {
    return { exists: false, value: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `provider_config.json \u4E0D\u662F\u5408\u6CD5 JSON\uFF08\u4FDD\u6301\u539F\u6837\u672A\u4FEE\u6539\uFF09\uFF0C\u8BF7\u5148\u4FEE\u590D\u8BE5\u6587\u4EF6\uFF1A${error instanceof Error ? error.message : String(error)}`
    );
  }
  const record = parsed;
  if (record?.schemaVersion !== 1 || !record.config || !Array.isArray(record.config.providerConfigRules?.providerRules)) {
    throw new Error("provider_config.json \u7ED3\u6784\u4E0D\u7B26\u5408 schemaVersion 1\uFF0C\u4E3A\u907F\u514D\u7834\u574F\u914D\u7F6E\u5DF2\u4E2D\u6B62\u5199\u5165");
  }
  return { exists: true, value: record };
}
async function backupFile(filePath) {
  try {
    const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
    const backupPath = `${filePath}.bak-${stamp}`;
    await writeFile2(backupPath, await readFile3(filePath), { mode: 384 });
    return backupPath;
  } catch {
    return null;
  }
}
async function atomicWrite(filePath, content) {
  let mode = 384;
  try {
    mode = (await stat(filePath)).mode & 511;
  } catch {
  }
  const tempPath = join3(dirname3(filePath), `.${basename2(filePath)}.${process.pid}.${Date.now()}.tmp`);
  await writeFile2(tempPath, content, { encoding: "utf-8", mode });
  try {
    await rename2(tempPath, filePath);
  } catch (error) {
    await rm3(tempPath, { force: true }).catch(() => void 0);
    throw error;
  }
}
async function upsertCopilotProviders(plans) {
  const run = lockChain.then(async () => {
    const filePath = providerConfigPath();
    await mkdir2(dirname3(filePath), { recursive: true });
    const lock = await acquireZcodeLock(filePath);
    try {
      const { exists, value } = await readProviderConfigFile(filePath);
      const current = value ?? {
        schemaVersion: 1,
        config: {
          providerConfigRules: { providerRules: [] },
          modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] }
        }
      };
      const ourIds = new Set(COPILOT_PROVIDER_IDS);
      const activeIds = new Set(plans.map((plan) => plan.providerId));
      const providerRules = current.config.providerConfigRules.providerRules.filter(
        (rule) => !ourIds.has(rule.providerId)
      );
      const modelRules = current.config.modelConfigRules.providerModelRules.filter(
        (rule) => !ourIds.has(rule.providerId)
      );
      const manualRules = current.config.modelConfigRules.manualProviderModelRules.filter(
        (rule) => !ourIds.has(rule.providerId)
      );
      const providerOrder = (current.config.providerOrder ?? []).filter((id) => !ourIds.has(id));
      for (const plan of plans) {
        const modelIds = plan.models.map((model) => model.modelId);
        providerRules.push({
          providerId: plan.providerId,
          providerName: plan.providerName,
          config: {
            group: "standard-personal",
            access: { type: "api-key", apiKey: "copilot-proxy" },
            api: { type: plan.apiType, baseUrl: plan.baseUrl },
            personalModelIds: modelIds,
            modelOrder: modelIds
          }
        });
        for (const model of plan.models) {
          modelRules.push({ providerId: plan.providerId, modelId: model.modelId, config: model.config });
        }
        providerOrder.push(plan.providerId);
      }
      const next = {
        ...current,
        config: {
          ...current.config,
          providerOrder,
          providerConfigRules: { providerRules },
          modelConfigRules: { providerModelRules: modelRules, manualProviderModelRules: manualRules }
        }
      };
      const backupPath = exists ? await backupFile(filePath) : null;
      await atomicWrite(filePath, JSON.stringify(next, null, 2) + "\n");
      return { backupPath };
    } finally {
      await lock.release();
    }
  });
  lockChain = run.catch(() => void 0);
  return run;
}
async function removeCopilotProviders() {
  const run = lockChain.then(async () => {
    const filePath = providerConfigPath();
    const { exists, value } = await readProviderConfigFile(filePath);
    if (!exists || !value) return { removed: false, backupPath: null };
    const lock = await acquireZcodeLock(filePath);
    try {
      const reread = await readProviderConfigFile(filePath);
      const current = reread.value;
      if (!current) return { removed: false, backupPath: null };
      const ourIds = new Set(COPILOT_PROVIDER_IDS);
      const providerRules = current.config.providerConfigRules.providerRules.filter(
        (rule) => !ourIds.has(rule.providerId)
      );
      const modelRules = current.config.modelConfigRules.providerModelRules.filter(
        (rule) => !ourIds.has(rule.providerId)
      );
      const manualRules = current.config.modelConfigRules.manualProviderModelRules.filter(
        (rule) => !ourIds.has(rule.providerId)
      );
      const providerOrder = (current.config.providerOrder ?? []).filter((id) => !ourIds.has(id));
      const removed = providerRules.length !== current.config.providerConfigRules.providerRules.length || modelRules.length !== current.config.modelConfigRules.providerModelRules.length;
      const next = {
        ...current,
        config: {
          ...current.config,
          ...providerOrder.length > 0 ? { providerOrder } : {},
          providerConfigRules: { providerRules },
          modelConfigRules: { providerModelRules: modelRules, manualProviderModelRules: manualRules }
        }
      };
      const backupPath = await backupFile(filePath);
      await atomicWrite(filePath, JSON.stringify(next, null, 2) + "\n");
      return { removed, backupPath };
    } finally {
      await lock.release();
    }
  });
  lockChain = run.catch(() => void 0);
  return run;
}
async function inspectCopilotProviders() {
  const filePath = providerConfigPath();
  const { value } = await readProviderConfigFile(filePath).catch(() => ({ exists: false, value: null }));
  if (!value) return [];
  const ourIds = new Set(COPILOT_PROVIDER_IDS);
  const modelIdsByProvider = /* @__PURE__ */ new Map();
  for (const rule of value.config.modelConfigRules.providerModelRules) {
    if (!ourIds.has(rule.providerId)) continue;
    const list = modelIdsByProvider.get(rule.providerId) ?? [];
    list.push(rule.modelId);
    modelIdsByProvider.set(rule.providerId, list);
  }
  return value.config.providerConfigRules.providerRules.filter((rule) => ourIds.has(rule.providerId)).map((rule) => ({
    providerId: rule.providerId,
    providerName: rule.providerName ?? void 0,
    baseUrl: rule.config.api?.baseUrl,
    apiType: rule.config.api?.type,
    modelIds: modelIdsByProvider.get(rule.providerId) ?? []
  }));
}

// src/setup.ts
function isEnableCandidate2(modelId) {
  const family = modelFamily(modelId);
  return family === "claude" || family === "responses" || modelId === "kimi-k3";
}
async function runSetup() {
  const daemonBefore = await checkDaemon();
  const piImport = await importFromPiIfAvailable();
  const credential = await readCredential();
  if (!credential?.refresh) {
    return {
      ok: false,
      credentialImportedFromPi: piImport.imported,
      loggedIn: false,
      daemonRunning: daemonBefore.ok,
      message: "\u5C1A\u672A\u767B\u5F55 GitHub Copilot\u3002\u8BF7\u5148\u8C03\u7528 copilot_login \u5B8C\u6210\u8BBE\u5907\u7801\u767B\u5F55\uFF0C\u518D\u6267\u884C copilot_setup\u3002"
    };
  }
  let copilotToken;
  let enterpriseDomain;
  let availableModelIds = [];
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
      message: `\u5237\u65B0 Copilot \u4EE4\u724C\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`
    };
  }
  let enabledIds = [];
  let catalogModels = [];
  try {
    const catalog = await fetchCopilotModels(copilotToken, enterpriseDomain);
    const enableTargets = catalog.policyModelIds.filter(isEnableCandidate2);
    enabledIds = enableTargets.length > 0 ? await enableCopilotModels(copilotToken, enableTargets, enterpriseDomain) : [];
    availableModelIds = [.../* @__PURE__ */ new Set([...catalog.availableModelIds, ...enabledIds])];
    catalogModels = catalog.models;
    const current = await readCredential();
    if (current) {
      await writeCredential({ ...current, availableModelIds });
    }
  } catch (error) {
    availableModelIds = (await readCredential())?.availableModelIds ?? [];
    if (availableModelIds.length === 0) {
      return {
        ok: false,
        credentialImportedFromPi: piImport.imported,
        loggedIn: true,
        daemonRunning: daemonBefore.ok,
        message: `\u62C9\u53D6 Copilot \u6A21\u578B\u5217\u8868\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`
      };
    }
  }
  const availableSet = new Set(availableModelIds);
  const availableModels = catalogModels.filter((model) => availableSet.has(model.id));
  if (availableModels.length !== availableModelIds.length) {
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
      message: "\u8BA2\u9605\u6CA1\u6709\u53EF\u7528\u7684\u6A21\u578B\uFF08\u5747\u4E0D\u652F\u6301\u5DE5\u5177\u8C03\u7528\u6216\u88AB\u7981\u7528\uFF09\u3002"
    };
  }
  const offTypes = /* @__PURE__ */ new Map();
  try {
    const baseUrl = copilotBaseUrl(copilotToken, enterpriseDomain);
    for (const model of availableModels) {
      if (modelFamily(model.id) !== "claude") continue;
      offTypes.set(model.id, await detectClaudeOffType(copilotToken, baseUrl, model.id));
    }
  } catch {
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
        const levels = model.config.optionSpecs.reasoningLevel?.values ?? [];
        return `${model.modelId}${levels.length > 0 ? ` (${levels.join("/")})` : ""}`;
      })
    })),
    daemonRunning: daemon.ok,
    message: [
      `\u5DF2\u6CE8\u518C ${plans.length} \u4E2A\u63D0\u4F9B\u5546 / ${availableModelIds.length} \u4E2A\u6A21\u578B\u3002`,
      backupPath ? `\u914D\u7F6E\u5907\u4EFD\uFF1A${backupPath}` : void 0,
      status.baseUrl ? `Copilot API\uFF1A${status.baseUrl}` : void 0
    ].filter(Boolean).join(" ")
  };
}
async function setupStatusView() {
  const [credential, daemon, providers] = await Promise.all([
    credentialStatus(),
    checkDaemon(),
    inspectCopilotProviders().catch(() => [])
  ]);
  return { credential, daemon, providers };
}

// src/cli.ts
function line(text = "") {
  process.stdout.write(text + "\n");
}
async function cmdStatus() {
  const view = await setupStatusView();
  line(`\u4EE3\u7406\u5730\u5740: ${proxyBaseUrl()}`);
  line(`daemon: ${view.daemon.ok ? `\u8FD0\u884C\u4E2D (pid ${view.daemon.pid ?? "?"})` : "\u672A\u8FD0\u884C"}`);
  if (view.credential.loggedIn) {
    const expires = view.credential.expiresAt ? new Date(view.credential.expiresAt).toISOString() : "?";
    line(`\u767B\u5F55: \u5DF2\u767B\u5F55\uFF08\u4EE4\u724C\u6709\u6548\u671F\u81F3 ${expires}\uFF0CAPI ${view.credential.baseUrl ?? "?"}\uFF09`);
  } else {
    line("\u767B\u5F55: \u672A\u767B\u5F55\uFF08login \u53EF\u5F00\u59CB\u8BBE\u5907\u7801\u767B\u5F55\uFF1B\u82E5 pi \u5DF2\u767B\u5F55\u4F1A\u81EA\u52A8\u5BFC\u5165\uFF09");
  }
  if (view.providers.length === 0) {
    line("ZCode \u63D0\u4F9B\u5546: \u672A\u6CE8\u518C\uFF08setup \u53EF\u4E00\u952E\u63A5\u5165\uFF09");
  } else {
    line("ZCode \u63D0\u4F9B\u5546:");
    for (const provider of view.providers) {
      line(`  - ${provider.providerId} (${provider.apiType} \u2192 ${provider.baseUrl}) \u6A21\u578B ${provider.modelIds.length} \u4E2A`);
    }
  }
}
async function cmdLogin() {
  const result = await beginLogin();
  if (result.alreadyLoggedIn) {
    line("\u5DF2\u767B\u5F55\uFF0C\u65E0\u9700\u91CD\u590D\u767B\u5F55\u3002");
    return;
  }
  line(`\u8BF7\u6253\u5F00 ${result.verificationUri} \u5E76\u8F93\u5165\u9A8C\u8BC1\u7801: ${result.userCode}`);
  if (result.browserOpened) line("\uFF08\u5DF2\u81EA\u52A8\u6253\u5F00\u6D4F\u89C8\u5668\uFF0C\u9A8C\u8BC1\u7801\u5DF2\u590D\u5236\u5230\u526A\u8D34\u677F\uFF09");
  line("\u7B49\u5F85\u6388\u6743\u2026");
  await waitForLogin();
  const state2 = loginState();
  if (state2.status === "complete") {
    line(`\u767B\u5F55\u6210\u529F\uFF0C\u8BA2\u9605\u53EF\u7528\u6A21\u578B ${state2.modelCount ?? 0} \u4E2A\u3002\u8FD0\u884C setup \u5B8C\u6210\u63A5\u5165\u3002`);
  } else {
    line(`\u767B\u5F55\u5931\u8D25: ${state2.error ?? "unknown"}`);
    process.exitCode = 1;
  }
}
async function cmdLogout() {
  await logout();
  line("\u5DF2\u6E05\u9664\u51ED\u636E\u3002");
}
async function cmdModels() {
  await importFromPiIfAvailable();
  const credential = await ensureFreshCredential();
  const catalog = await fetchCopilotModels(credential.access, credential.enterpriseDomain);
  for (const model of catalog.models) {
    const marker = catalog.availableModelIds.includes(model.id) ? "\u2713" : " ";
    line(`${marker} ${model.id.padEnd(28)} ${modelFamily(model.id).padEnd(12)} policy=${model.policyState ?? "-"} picker=${model.pickerEnabled}`);
  }
  line(`
\u53EF\u7528\uFF08\u5C06\u6CE8\u518C\u8FDB ZCode\uFF09: ${catalog.availableModelIds.length} / ${catalog.models.length}`);
}
async function cmdSetup() {
  const summary = await runSetup();
  line(JSON.stringify(summary, null, 2));
  process.exitCode = summary.ok ? 0 : 1;
}
async function cmdRemove() {
  const result = await removeCopilotProviders();
  line(JSON.stringify(result, null, 2));
}
async function cmdDaemon(action) {
  if (action === "start") {
    const health = await ensureDaemon();
    line(health.ok ? `daemon \u5DF2\u8FD0\u884C: ${proxyBaseUrl()} (pid ${health.pid ?? "?"})` : "daemon \u542F\u52A8\u5931\u8D25");
  } else if (action === "stop") {
    line(JSON.stringify(await stopDaemon()));
  } else if (action === "status") {
    line(JSON.stringify(await checkDaemon(), null, 2));
  } else {
    line(`\u672A\u77E5 daemon \u5B50\u547D\u4EE4: ${action}\uFF08\u53EF\u7528: start | stop | status\uFF09`);
    process.exitCode = 1;
  }
}
async function main() {
  const [command, sub] = process.argv.slice(2);
  switch (command) {
    case "status":
      await cmdStatus();
      return;
    case "login":
      await cmdLogin();
      return;
    case "logout":
      await cmdLogout();
      return;
    case "models":
      await cmdModels();
      return;
    case "setup":
      await cmdSetup();
      return;
    case "remove":
      await cmdRemove();
      return;
    case "daemon":
      await cmdDaemon(sub ?? "status");
      return;
    default:
      line("zcode-copilot CLI");
      line("\u7528\u6CD5: node dist/cli.mjs <status|login|logout|models|setup|remove|daemon start|stop|status>");
      process.exitCode = command ? 1 : 0;
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
//# sourceMappingURL=cli.mjs.map
