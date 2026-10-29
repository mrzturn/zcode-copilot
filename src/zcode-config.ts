/**
 * 读写 ZCode 个人提供商配置（~/.zcode/v2/provider_config.json）。
 *
 * 与 ZCode（@zcode/provider-node）保持互操作：
 * - 同协议的文件锁：<file>.lock/ 目录 + owner-<token>.json（含 pid/createdAt），
 *   对端进程死亡或锁陈旧时按相同语义回收；
 * - 原子替换写入（临时文件 + rename），权限 0600；
 * - 文件损坏时不覆盖（对端策略也是保留现场等待修复）；
 * - 修改前先做时间戳备份。
 */

import { mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { sleep } from "./copilot/constants.ts";

export const COPILOT_PROVIDER_IDS = ["copilot-claude", "copilot-gpt", "copilot-openai"] as const;
export type CopilotProviderId = (typeof COPILOT_PROVIDER_IDS)[number];

export interface PersonalProviderRule {
  providerId: string;
  providerName?: string | null;
  enabled?: boolean;
  config: {
    group?: string | null;
    access?: { type: string; apiKey?: string } | null;
    api?: { type: string; baseUrl: string } | null;
    personalModelIds?: string[];
    modelOrder?: string[];
    [key: string]: unknown;
  };
}

interface ProviderConfigFile {
  schemaVersion: number;
  config: {
    providerOrder?: string[];
    providerConfigRules: { providerRules: PersonalProviderRule[] };
    modelConfigRules: {
      providerModelRules: Array<{ providerId: string; modelId: string; config: Record<string, unknown> }>;
      manualProviderModelRules: Array<{ providerId: string; modelId: string; config: Record<string, unknown> }>;
    };
    defaultModelSelection?: unknown;
    [key: string]: unknown;
  };
}

export function providerConfigPath(): string {
  return process.env.ZCODE_PROVIDER_CONFIG_FILE?.trim() || join(homedir(), ".zcode", "v2", "provider_config.json");
}

/** 进程内串行化，避免本进程并发拿锁自我竞争。 */
let lockChain: Promise<unknown> = Promise.resolve();

interface LockHandle {
  release: () => Promise<void>;
}

async function acquireZcodeLock(filePath: string): Promise<LockHandle> {
  const lockDir = `${filePath}.lock`;
  const token = `${process.pid}-${Math.random().toString(16).slice(2)}`;
  const ownerPath = join(lockDir, `owner-${token}.json`);
  const deadline = Date.now() + 8000;
  for (;;) {
    try {
      await mkdir(lockDir, { recursive: false });
      await writeFile(ownerPath, JSON.stringify({ pid: process.pid, createdAt: Date.now() }) + "\n", "utf-8");
      return {
        release: async () => {
          await rm(ownerPath, { force: true }).catch(() => undefined);
          await rmdir(lockDir).catch(() => undefined);
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const reclaimed = await tryReclaimStaleLock(lockDir);
    if (reclaimed) continue;
    if (Date.now() > deadline) {
      throw new Error("等待 provider_config.json 文件锁超时（ZCode 可能正在写入），请稍后重试");
    }
    await sleep(120);
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function tryReclaimStaleLock(lockDir: string): Promise<boolean> {
  let entries: string[];
  try {
    entries = await readdir(lockDir);
  } catch {
    return true; // 目录已消失，直接重试创建。
  }
  const owners = entries.filter((entry) => entry.startsWith("owner-") && entry.endsWith(".json"));
  if (owners.length === 0) {
    // 空目录/异常目录：超过宽限期后整体回收（与 ZCode 行为一致）。
    try {
      const info = await stat(lockDir);
      if (Date.now() - info.mtimeMs > 10_000) {
        await rmdir(lockDir).catch(() => undefined);
        return true;
      }
    } catch {
      // ignore
    }
    return false;
  }
  for (const owner of owners) {
    const ownerPath = join(lockDir, owner);
    try {
      const meta = JSON.parse(await readFile(ownerPath, "utf-8")) as { pid?: unknown; createdAt?: unknown };
      const pid = typeof meta.pid === "number" && Number.isSafeInteger(meta.pid) && meta.pid > 0 ? meta.pid : null;
      const createdAt = typeof meta.createdAt === "number" ? meta.createdAt : null;
      if (pid !== null && isProcessAlive(pid) && createdAt !== null && Date.now() - createdAt < 30_000) {
        return false; // 活锁持有者，等待。
      }
    } catch {
      // owner 文件损坏：可回收。
    }
    await rm(ownerPath, { force: true }).catch(() => undefined);
  }
  return true;
}

async function readProviderConfigFile(filePath: string): Promise<{ exists: boolean; value: ProviderConfigFile | null }> {
  let text: string;
  try {
    text = await readFile(filePath, "utf-8");
  } catch {
    return { exists: false, value: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `provider_config.json 不是合法 JSON（保持原样未修改），请先修复该文件：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const record = parsed as ProviderConfigFile;
  if (record?.schemaVersion !== 1 || !record.config || !Array.isArray(record.config.providerConfigRules?.providerRules)) {
    throw new Error("provider_config.json 结构不符合 schemaVersion 1，为避免破坏配置已中止写入");
  }
  return { exists: true, value: record };
}

async function backupFile(filePath: string): Promise<string | null> {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = `${filePath}.bak-${stamp}`;
    await writeFile(backupPath, await readFile(filePath), { mode: 0o600 });
    return backupPath;
  } catch {
    return null;
  }
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  let mode = 0o600;
  try {
    mode = (await stat(filePath)).mode & 0o777;
  } catch {
    // 新文件用 0600。
  }
  const tempPath = join(dirname(filePath), `.${basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tempPath, content, { encoding: "utf-8", mode });
  try {
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export interface ProviderPlan {
  providerId: CopilotProviderId;
  providerName: string;
  apiType: "anthropic-messages" | "openai-responses" | "openai-chat-completions";
  baseUrl: string;
  models: Array<{ modelId: string; config: Record<string, unknown> }>;
}

/**
 * 在 Zcode 锁内合并写入插件管理的提供商条目：
 * 只替换 COPILOT_PROVIDER_IDS 名下的规则，保留用户其余配置。
 */
export async function upsertCopilotProviders(plans: ProviderPlan[]): Promise<{ backupPath: string | null }> {
  const run = lockChain.then(async () => {
    const filePath = providerConfigPath();
    await mkdir(dirname(filePath), { recursive: true });
    const lock = await acquireZcodeLock(filePath);
    try {
      const { exists, value } = await readProviderConfigFile(filePath);
      const current: ProviderConfigFile =
        value ??
        ({
          schemaVersion: 1,
          config: {
            providerConfigRules: { providerRules: [] },
            modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
          },
        } as ProviderConfigFile);

      const ourIds = new Set<string>(COPILOT_PROVIDER_IDS);
      const activeIds = new Set(plans.map((plan) => plan.providerId));

      const providerRules = current.config.providerConfigRules.providerRules.filter(
        (rule) => !ourIds.has(rule.providerId),
      );
      const modelRules = current.config.modelConfigRules.providerModelRules.filter(
        (rule) => !ourIds.has(rule.providerId),
      );
      const manualRules = current.config.modelConfigRules.manualProviderModelRules.filter(
        (rule) => !ourIds.has(rule.providerId),
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
            modelOrder: modelIds,
          },
        });
        for (const model of plan.models) {
          modelRules.push({ providerId: plan.providerId, modelId: model.modelId, config: model.config });
        }
        providerOrder.push(plan.providerId);
      }

      const next: ProviderConfigFile = {
        ...current,
        config: {
          ...current.config,
          providerOrder,
          providerConfigRules: { providerRules },
          modelConfigRules: { providerModelRules: modelRules, manualProviderModelRules: manualRules },
        },
      };
      void activeIds;

      const backupPath = exists ? await backupFile(filePath) : null;
      await atomicWrite(filePath, JSON.stringify(next, null, 2) + "\n");
      return { backupPath };
    } finally {
      await lock.release();
    }
  });
  lockChain = run.catch(() => undefined);
  return run;
}

/** 移除插件写入的全部提供商条目。 */
export async function removeCopilotProviders(): Promise<{ removed: boolean; backupPath: string | null }> {
  const run = lockChain.then(async () => {
    const filePath = providerConfigPath();
    const { exists, value } = await readProviderConfigFile(filePath);
    if (!exists || !value) return { removed: false, backupPath: null };
    const lock = await acquireZcodeLock(filePath);
    try {
      // 拿锁后重读，避免用旧快照覆盖。
      const reread = await readProviderConfigFile(filePath);
      const current = reread.value;
      if (!current) return { removed: false, backupPath: null };
      const ourIds = new Set<string>(COPILOT_PROVIDER_IDS);
      const providerRules = current.config.providerConfigRules.providerRules.filter(
        (rule) => !ourIds.has(rule.providerId),
      );
      const modelRules = current.config.modelConfigRules.providerModelRules.filter(
        (rule) => !ourIds.has(rule.providerId),
      );
      const manualRules = current.config.modelConfigRules.manualProviderModelRules.filter(
        (rule) => !ourIds.has(rule.providerId),
      );
      const providerOrder = (current.config.providerOrder ?? []).filter((id) => !ourIds.has(id));
      const removed =
        providerRules.length !== current.config.providerConfigRules.providerRules.length ||
        modelRules.length !== current.config.modelConfigRules.providerModelRules.length;
      const next: ProviderConfigFile = {
        ...current,
        config: {
          ...current.config,
          ...(providerOrder.length > 0 ? { providerOrder } : {}),
          providerConfigRules: { providerRules },
          modelConfigRules: { providerModelRules: modelRules, manualProviderModelRules: manualRules },
        },
      };
      const backupPath = await backupFile(filePath);
      await atomicWrite(filePath, JSON.stringify(next, null, 2) + "\n");
      return { removed, backupPath };
    } finally {
      await lock.release();
    }
  });
  lockChain = run.catch(() => undefined);
  return run;
}

/** 只读摘要，供状态展示。 */
export async function inspectCopilotProviders(): Promise<
  Array<{ providerId: string; providerName?: string; baseUrl?: string; apiType?: string; modelIds: string[] }>
> {
  const filePath = providerConfigPath();
  const { value } = await readProviderConfigFile(filePath).catch(() => ({ exists: false, value: null }));
  if (!value) return [];
  const ourIds = new Set<string>(COPILOT_PROVIDER_IDS);
  const modelIdsByProvider = new Map<string, string[]>();
  for (const rule of value.config.modelConfigRules.providerModelRules) {
    if (!ourIds.has(rule.providerId)) continue;
    const list = modelIdsByProvider.get(rule.providerId) ?? [];
    list.push(rule.modelId);
    modelIdsByProvider.set(rule.providerId, list);
  }
  return value.config.providerConfigRules.providerRules
    .filter((rule) => ourIds.has(rule.providerId))
    .map((rule) => ({
      providerId: rule.providerId,
      providerName: rule.providerName ?? undefined,
      baseUrl: rule.config.api?.baseUrl,
      apiType: rule.config.api?.type,
      modelIds: modelIdsByProvider.get(rule.providerId) ?? [],
    }));
}
