// src/daemon.ts
import { appendFile, mkdir as mkdir2, writeFile as writeFile2 } from "node:fs/promises";
import { dirname as dirname2 } from "node:path";

// src/copilot/constants.ts
var COPILOT_USER_AGENT = "GitHubCopilotChat/0.35.0";
var COPILOT_STATIC_HEADERS = {
  "User-Agent": COPILOT_USER_AGENT,
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat"
};
var DEFAULT_COPILOT_BASE_URL = "https://api.individual.githubcopilot.com";
var DEFAULT_PROXY_PORT = 48911;
function proxyPort() {
  const parsed = Number.parseInt(process.env.ZCODE_COPILOT_PORT ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : DEFAULT_PROXY_PORT;
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

// src/proxy.ts
import { createServer } from "node:http";
import { Readable } from "node:stream";

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
function daemonLogPath() {
  return join(pluginDataDir(), "daemon.log");
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

// src/proxy.ts
var MAX_BODY_BYTES = 256 * 1024 * 1024;
function route(method, rawPath) {
  const path = rawPath.replace(/\/+$/, "") || "/";
  if (method === "GET" && (path === "/v1/models" || path === "/models")) {
    return { upstreamPath: "/models", kind: "models" };
  }
  if (method === "POST") {
    if (path === "/v1/messages" || path === "/messages") {
      return { upstreamPath: "/v1/messages", kind: "messages" };
    }
    if (path === "/v1/chat/completions" || path === "/chat/completions") {
      return { upstreamPath: "/chat/completions", kind: "chat" };
    }
    if (path === "/v1/responses" || path === "/responses") {
      return { upstreamPath: "/responses", kind: "responses" };
    }
  }
  return null;
}
async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new Error("Request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}
function errorPayload(message) {
  return { error: { message, type: "zcode_copilot_proxy_error" } };
}
function analyzeBody(parsed) {
  const result = { hasImage: false };
  if (!parsed || typeof parsed !== "object") return result;
  const messages = parsed.messages;
  if (!Array.isArray(messages)) return result;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object") continue;
    if (result.lastRole === void 0 && typeof message.role === "string") {
      result.lastRole = message.role;
    }
    const content = message.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        const type = part?.type;
        if (type === "image_url" || type === "image" || type === "input_image" || type === "source") {
          result.hasImage = true;
        }
      }
    }
  }
  return result;
}
function sanitizeChatCompletionsBody(parsed) {
  if (!parsed || typeof parsed !== "object") return parsed;
  const body = { ...parsed };
  delete body.store;
  delete body.reasoning_effort;
  if (Array.isArray(body.messages)) {
    body.messages = body.messages.map((message) => {
      if (message && typeof message === "object" && message.role === "developer") {
        return { ...message, role: "system" };
      }
      return message;
    });
  }
  return body;
}
function createProxyServer() {
  return createServer((req, res) => {
    void handle(req, res).catch((error) => {
      if (res.headersSent) {
        res.destroy(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof NotLoggedInError) {
        sendJson(res, 503, errorPayload(message));
      } else {
        sendJson(res, 502, errorPayload(`Copilot proxy request failed: ${message}`));
      }
    });
  });
}
async function handle(req, res) {
  if (req.method === "GET" && (req.url === "/health" || req.url === "/")) {
    const status = await credentialStatus();
    sendJson(res, 200, { ok: true, service: "zcode-copilot", ...status });
    return;
  }
  const routeInfo = route(req.method ?? "GET", req.url ?? "/");
  if (!routeInfo) {
    sendJson(res, 404, errorPayload(`No proxy route for ${req.method} ${req.url}`));
    return;
  }
  const credential = await ensureFreshCredential();
  const baseUrl = copilotBaseUrl(credential.access, credential.enterpriseDomain);
  const upstreamUrl = `${baseUrl}${routeInfo.upstreamPath}`;
  const bodyBuffer = routeInfo.kind === "models" ? null : await readBody(req);
  let bodyToSend = bodyBuffer;
  let analysis = { hasImage: false };
  if (bodyBuffer !== null && bodyBuffer.length > 0) {
    try {
      const parsed = JSON.parse(bodyBuffer.toString("utf-8"));
      analysis = analyzeBody(parsed);
      const sanitized = routeInfo.kind === "chat" ? sanitizeChatCompletionsBody(parsed) : parsed;
      bodyToSend = Buffer.from(JSON.stringify(sanitized), "utf-8");
    } catch {
    }
  }
  const headers = {
    Authorization: `Bearer ${credential.access}`,
    ...COPILOT_STATIC_HEADERS,
    "Openai-Intent": "conversation-edits",
    // 最后一条消息不是用户消息（如工具结果）时，本请求由 agent 发起。
    "X-Initiator": analysis.lastRole !== void 0 && analysis.lastRole !== "user" ? "agent" : "user"
  };
  const clientAccept = req.headers.accept;
  if (clientAccept) headers.Accept = clientAccept;
  if (routeInfo.kind === "messages") {
    headers["anthropic-version"] = req.headers["anthropic-version"] ?? "2023-06-01";
  }
  if (routeInfo.kind === "models") {
    headers.Accept = "application/json";
    headers["X-GitHub-Api-Version"] = "2026-06-01";
    delete headers["Openai-Intent"];
    delete headers["X-Initiator"];
  }
  if (analysis.hasImage) {
    headers["Copilot-Vision-Request"] = "true";
  }
  if (bodyToSend !== null) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = String(bodyToSend.length);
  }
  const upstreamAbort = new AbortController();
  req.on("close", () => upstreamAbort.abort());
  let upstream;
  try {
    upstream = await fetch(upstreamUrl, {
      method: routeInfo.kind === "models" ? "GET" : "POST",
      headers,
      body: bodyToSend ?? void 0,
      signal: upstreamAbort.signal
    });
  } catch (error) {
    if (upstreamAbort.signal.aborted) return;
    throw error;
  }
  if (!upstream.ok && !upstream.body) {
    const text = await upstream.text();
    sendJson(res, upstream.status, {
      error: { message: `Copilot API ${upstream.status}: ${text.slice(0, 2e3)}`, type: "upstream_error" }
    });
    return;
  }
  const responseHeaders = {};
  const contentType = upstream.headers.get("content-type");
  if (contentType) responseHeaders["Content-Type"] = contentType;
  res.writeHead(upstream.status, responseHeaders);
  if (!upstream.body) {
    res.end();
    return;
  }
  const nodeStream = Readable.fromWeb(upstream.body);
  nodeStream.pipe(res);
  nodeStream.on("error", (error) => {
    res.destroy(error instanceof Error ? error : new Error(String(error)));
  });
}

// src/daemon.ts
async function log(line) {
  try {
    await mkdir2(dirname2(daemonLogPath()), { recursive: true });
    await appendFile(daemonLogPath(), `[${(/* @__PURE__ */ new Date()).toISOString()}] ${line}
`, "utf-8");
  } catch {
  }
}
async function main() {
  const port = proxyPort();
  const server = createProxyServer();
  const shutdown = (signal) => {
    void log(`received ${signal}, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3e3).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  await mkdir2(pluginDataDir(), { recursive: true });
  await writeFile2(
    daemonMetaPath(),
    JSON.stringify({ pid: process.pid, port, startedAt: Date.now() }, null, 2) + "\n",
    "utf-8"
  );
  await log(`daemon listening on 127.0.0.1:${port} (pid ${process.pid})`);
  await new Promise(() => void 0);
}
main().catch(async (error) => {
  const code = error?.code;
  if (code === "EADDRINUSE") {
    await log(`port already in use, assuming existing daemon; exiting (pid ${process.pid})`);
    process.exit(0);
  }
  await log(`daemon failed to start: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  console.error(error);
  process.exit(1);
});
//# sourceMappingURL=daemon.mjs.map
