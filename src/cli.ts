/**
 * 调试 CLI：
 *   node dist/cli.mjs status | login | logout | models | setup | remove | daemon start|stop|status
 */

import { proxyBaseUrl } from "./copilot/constants.ts";
import { checkDaemon, ensureDaemon, stopDaemon } from "./daemon-manage.ts";
import { beginLogin, loginState, logout, waitForLogin } from "./login-flow.ts";
import { ensureFreshCredential } from "./token-manager.ts";
import { fetchCopilotModels } from "./copilot/models.ts";
import { importFromPiIfAvailable } from "./store.ts";
import { modelFamily } from "./catalog.ts";
import { runSetup, setupStatusView } from "./setup.ts";
import { removeCopilotProviders } from "./zcode-config.ts";

function line(text = ""): void {
  process.stdout.write(text + "\n");
}

async function cmdStatus(): Promise<void> {
  const view = await setupStatusView();
  line(`代理地址: ${proxyBaseUrl()}`);
  line(`daemon: ${view.daemon.ok ? `运行中 (pid ${view.daemon.pid ?? "?"})` : "未运行"}`);
  if (view.credential.loggedIn) {
    const expires = view.credential.expiresAt ? new Date(view.credential.expiresAt).toISOString() : "?";
    line(`登录: 已登录（令牌有效期至 ${expires}，API ${view.credential.baseUrl ?? "?"}）`);
  } else {
    line("登录: 未登录（login 可开始设备码登录；若 pi 已登录会自动导入）");
  }
  if (view.providers.length === 0) {
    line("ZCode 提供商: 未注册（setup 可一键接入）");
  } else {
    line("ZCode 提供商:");
    for (const provider of view.providers) {
      line(`  - ${provider.providerId} (${provider.apiType} → ${provider.baseUrl}) 模型 ${provider.modelIds.length} 个`);
    }
  }
}

async function cmdLogin(): Promise<void> {
  const result = await beginLogin();
  if (result.alreadyLoggedIn) {
    line("已登录，无需重复登录。");
    return;
  }
  line(`请打开 ${result.verificationUri} 并输入验证码: ${result.userCode}`);
  if (result.browserOpened) line("（已自动打开浏览器，验证码已复制到剪贴板）");
  line("等待授权…");
  await waitForLogin();
  const state = loginState();
  if (state.status === "complete") {
    line(`登录成功，订阅可用模型 ${state.modelCount ?? 0} 个。运行 setup 完成接入。`);
  } else {
    line(`登录失败: ${state.error ?? "unknown"}`);
    process.exitCode = 1;
  }
}

async function cmdLogout(): Promise<void> {
  await logout();
  line("已清除凭据。");
}

async function cmdModels(): Promise<void> {
  await importFromPiIfAvailable();
  const credential = await ensureFreshCredential();
  const catalog = await fetchCopilotModels(credential.access, credential.enterpriseDomain);
  for (const model of catalog.models) {
    const marker = catalog.availableModelIds.includes(model.id) ? "✓" : " ";
    line(`${marker} ${model.id.padEnd(28)} ${modelFamily(model.id).padEnd(12)} policy=${model.policyState ?? "-"} picker=${model.pickerEnabled}`);
  }
  line(`\n可用（将注册进 ZCode）: ${catalog.availableModelIds.length} / ${catalog.models.length}`);
}

async function cmdSetup(): Promise<void> {
  const summary = await runSetup();
  line(JSON.stringify(summary, null, 2));
  process.exitCode = summary.ok ? 0 : 1;
}

async function cmdRemove(): Promise<void> {
  const result = await removeCopilotProviders();
  line(JSON.stringify(result, null, 2));
}

async function cmdDaemon(action: string): Promise<void> {
  if (action === "start") {
    const health = await ensureDaemon();
    line(health.ok ? `daemon 已运行: ${proxyBaseUrl()} (pid ${health.pid ?? "?"})` : "daemon 启动失败");
  } else if (action === "stop") {
    line(JSON.stringify(await stopDaemon()));
  } else if (action === "status") {
    line(JSON.stringify(await checkDaemon(), null, 2));
  } else {
    line(`未知 daemon 子命令: ${action}（可用: start | stop | status）`);
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
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
      line("用法: node dist/cli.mjs <status|login|logout|models|setup|remove|daemon start|stop|status>");
      process.exitCode = command ? 1 : 0;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
