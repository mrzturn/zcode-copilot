/**
 * daemon 生命周期管理：健康检查、detached 拉起、停止。
 * MCP 服务器与 CLI 都通过 ensureDaemon() 保证代理在跑。
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFile, rm } from "node:fs/promises";
import { proxyBaseUrl, proxyPort } from "./copilot/constants.ts";
import { daemonMetaPath } from "./store.ts";

export interface DaemonHealth {
  ok: boolean;
  loggedIn?: boolean;
  expiresAt?: number;
  baseUrl?: string;
  pid?: number;
}

export async function checkDaemon(timeoutMs = 1200): Promise<DaemonHealth> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${proxyBaseUrl()}/health`, { signal: controller.signal });
    if (!response.ok) return { ok: false };
    const payload = (await response.json()) as Record<string, unknown>;
    let pid: number | undefined;
    try {
      const meta = JSON.parse(await readFile(daemonMetaPath(), "utf-8")) as { pid?: unknown };
      if (typeof meta.pid === "number") pid = meta.pid;
    } catch {
      // meta 文件缺失不影响健康判断。
    }
    return {
      ok: true,
      loggedIn: payload.loggedIn === true,
      expiresAt: typeof payload.expiresAt === "number" ? payload.expiresAt : undefined,
      baseUrl: typeof payload.baseUrl === "string" ? payload.baseUrl : undefined,
      pid,
    };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

function daemonScriptPath(): string {
  // 打包后各入口是 dist/ 下平级的独立 bundle。
  return join(dirname(fileURLToPath(import.meta.url)), "daemon.mjs");
}

/**
 * 确保 daemon 在跑：健康则复用；否则 detached 拉起并等待就绪。
 */
export async function ensureDaemon(options: { waitMs?: number } = {}): Promise<DaemonHealth> {
  const existing = await checkDaemon();
  if (existing.ok) return existing;

  const child = spawn(process.execPath, [daemonScriptPath()], {
    env: { ...process.env, ZCODE_COPILOT_PORT: String(proxyPort()) },
    stdio: "ignore",
    detached: true,
  });
  child.unref();

  const deadline = Date.now() + (options.waitMs ?? 6000);
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const health = await checkDaemon(600);
    if (health.ok) return health;
  }
  throw new Error(
    `Copilot 代理 daemon 启动失败（端口 ${proxyPort()}）。可手动运行排查：node ${daemonScriptPath()}`,
  );
}

export async function stopDaemon(): Promise<{ stopped: boolean; note?: string }> {
  const health = await checkDaemon(600);
  if (!health.ok) return { stopped: false, note: "daemon not running" };
  let pid = health.pid;
  if (!pid) {
    try {
      const meta = JSON.parse(await readFile(daemonMetaPath(), "utf-8")) as { pid?: unknown };
      if (typeof meta.pid === "number") pid = meta.pid;
    } catch {
      // ignore
    }
  }
  if (!pid) return { stopped: false, note: "daemon running but pid unknown" };
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      return { stopped: false, note: `failed to signal pid ${pid}` };
    }
  }
  await rm(daemonMetaPath(), { force: true }).catch(() => undefined);
  return { stopped: true };
}
