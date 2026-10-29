/**
 * 常驻代理 daemon 入口。独立于 ZCode 会话进程存活：
 *   node dist/daemon.mjs
 * 单实例：端口被占用且已有健康实例时直接退出。
 */

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { proxyPort } from "./copilot/constants.ts";
import { createProxyServer } from "./proxy.ts";
import { daemonLogPath, daemonMetaPath, pluginDataDir } from "./store.ts";

async function log(line: string): Promise<void> {
  try {
    await mkdir(dirname(daemonLogPath()), { recursive: true });
    await appendFile(daemonLogPath(), `[${new Date().toISOString()}] ${line}\n`, "utf-8");
  } catch {
    // 日志失败不影响服务。
  }
}

async function main(): Promise<void> {
  const port = proxyPort();
  const server = createProxyServer();

  const shutdown = (signal: string) => {
    void log(`received ${signal}, shutting down`);
    server.close(() => process.exit(0));
    // 兜底：连接未及时断开也最多等 3 秒。
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });

  await mkdir(pluginDataDir(), { recursive: true });
  await writeFile(
    daemonMetaPath(),
    JSON.stringify({ pid: process.pid, port, startedAt: Date.now() }, null, 2) + "\n",
    "utf-8",
  );
  await log(`daemon listening on 127.0.0.1:${port} (pid ${process.pid})`);

  // 保持进程运行（server 本身已持有事件循环，这里只是显式语义）。
  await new Promise<void>(() => undefined);
}

main().catch(async (error: unknown) => {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "EADDRINUSE") {
    // 已有实例在跑：健康检查由调用方（daemon-manage）负责，这里静默退出。
    await log(`port already in use, assuming existing daemon; exiting (pid ${process.pid})`);
    process.exit(0);
  }
  await log(`daemon failed to start: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  console.error(error);
  process.exit(1);
});
