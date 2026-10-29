/**
 * 凭据存储：~/.zcode-copilot/auth.json（0600）。
 * 支持从 pi（~/.pi/agent/auth.json 的 github-copilot 项）导入，避免重复登录。
 * 写入用原子替换；跨进程刷新竞争无害（交换接口幂等，后写覆盖前写仍是有效令牌）。
 */

import { chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import type { CopilotCredential } from "./copilot/token.ts";

export function pluginDataDir(): string {
  return process.env.ZCODE_COPILOT_HOME?.trim() || join(homedir(), ".zcode-copilot");
}

export function authFilePath(): string {
  return join(pluginDataDir(), "auth.json");
}

export function daemonMetaPath(): string {
  return join(pluginDataDir(), "daemon.json");
}

export function daemonLogPath(): string {
  return join(pluginDataDir(), "daemon.log");
}

/** 进程内串行化写，避免本进程并发刷新交错写文件。 */
let writeChain: Promise<unknown> = Promise.resolve();

export async function readCredential(): Promise<CopilotCredential | null> {
  try {
    const text = await readFile(authFilePath(), "utf-8");
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (typeof parsed.refresh !== "string" || typeof parsed.access !== "string") return null;
    return {
      refresh: parsed.refresh,
      access: parsed.access,
      expires: typeof parsed.expires === "number" ? parsed.expires : 0,
      enterpriseDomain: typeof parsed.enterpriseDomain === "string" ? parsed.enterpriseDomain : undefined,
      availableModelIds: Array.isArray(parsed.availableModelIds)
        ? (parsed.availableModelIds as unknown[]).filter((id): id is string => typeof id === "string")
        : undefined,
    };
  } catch {
    return null;
  }
}

export async function writeCredential(credential: CopilotCredential): Promise<void> {
  const run = writeChain.then(async () => {
    const filePath = authFilePath();
    await mkdir(dirname(filePath), { recursive: true });
    const tempPath = join(
      dirname(filePath),
      `.${basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
    );
    await writeFile(tempPath, JSON.stringify(credential, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
    try {
      await rename(tempPath, filePath);
      await chmod(filePath, 0o600).catch(() => undefined);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  });
  writeChain = run.catch(() => undefined);
  await run;
}

export async function deleteCredential(): Promise<boolean> {
  try {
    await rm(authFilePath(), { force: true });
    return true;
  } catch {
    return false;
  }
}

export interface PiImportResult {
  imported: boolean;
  reason?: string;
}

/**
 * 从 pi 的凭据文件导入 GitHub Copilot 登录（refresh 令牌长期有效，可跨工具共用）。
 * 只在本地无凭据且 pi 有有效项时导入。
 */
export async function importFromPiIfAvailable(): Promise<PiImportResult> {
  const existing = await readCredential();
  if (existing) return { imported: false, reason: "already logged in" };
  const piAuthPath = join(homedir(), ".pi", "agent", "auth.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(piAuthPath, "utf-8"));
  } catch {
    return { imported: false, reason: "no pi credential found" };
  }
  const copilot = (parsed as Record<string, unknown>)["github-copilot"] as Record<string, unknown> | undefined;
  const refresh = copilot?.refresh;
  if (typeof refresh !== "string" || !refresh) {
    return { imported: false, reason: "pi has no github-copilot credential" };
  }
  await writeCredential({
    refresh,
    access: typeof copilot?.access === "string" ? copilot.access : "",
    expires: typeof copilot?.expires === "number" ? copilot.expires : 0,
    enterpriseDomain:
      typeof copilot?.enterpriseUrl === "string" && copilot.enterpriseUrl ? copilot.enterpriseUrl : undefined,
    availableModelIds: undefined,
  });
  return { imported: true };
}

/** 调试/回滚用：备份一份当前凭据。 */
export async function backupCredential(target: string): Promise<void> {
  const source = authFilePath();
  try {
    await copyFile(source, target);
  } catch {
    // 源文件不存在时忽略。
  }
}
