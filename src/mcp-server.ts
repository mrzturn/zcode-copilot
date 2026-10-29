/**
 * ZCode 插件 MCP 服务器（stdio）。
 * 工具：copilot_status / copilot_login / copilot_login_check / copilot_logout /
 *       copilot_models / copilot_setup / copilot_remove
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { proxyBaseUrl } from "./copilot/constants.ts";
import { ensureDaemon } from "./daemon-manage.ts";
import { beginLogin, loginState, logout } from "./login-flow.ts";
import { ensureFreshCredential } from "./token-manager.ts";
import { fetchCopilotModels } from "./copilot/models.ts";
import { importFromPiIfAvailable } from "./store.ts";
import { modelFamily } from "./catalog.ts";
import { runSetup, setupStatusView } from "./setup.ts";
import { removeCopilotProviders } from "./zcode-config.ts";

const PLUGIN_VERSION = "0.0.1";

function textResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  const server = new McpServer({ name: "zcode-copilot", version: PLUGIN_VERSION });

  server.registerTool(
    "copilot_status",
    {
      title: "Copilot 接入状态",
      description:
        "查看 GitHub Copilot 接入状态：登录态与令牌过期时间、本地代理 daemon 健康状况、已注册到 ZCode 的提供商与模型。",
      inputSchema: z.object({}),
    },
    async () => {
      const view = await setupStatusView();
      const pending = loginState();
      return textResult({
        proxyBaseUrl: proxyBaseUrl(),
        credential: view.credential,
        daemon: view.daemon,
        providers: view.providers,
        pendingLogin:
          pending.status === "pending"
            ? { userCode: pending.userCode, verificationUri: pending.verificationUri }
            : undefined,
        nextStep: view.credential.loggedIn
          ? view.providers.length > 0
            ? "一切就绪：在 ZCode 模型选择器中选择 copilot-claude / copilot-gpt 提供商下的模型即可使用。"
            : "已登录但尚未注册提供商，调用 copilot_setup 完成一键接入。"
          : "未登录：调用 copilot_login 开始设备码登录（若本机 pi 已登录过 Copilot，copilot_setup 会自动导入凭据）。",
      });
    },
  );

  server.registerTool(
    "copilot_login",
    {
      title: "登录 GitHub Copilot",
      description:
        "发起 GitHub 设备码登录。立即返回验证码与验证链接（并自动打开浏览器、复制验证码）；后台等待用户完成授权。之后用 copilot_login_check 查询结果。",
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const result = await beginLogin();
        if (result.alreadyLoggedIn) {
          return textResult({ alreadyLoggedIn: true, message: "已登录 GitHub Copilot，无需重复登录。" });
        }
        return textResult({
          alreadyLoggedIn: false,
          userCode: result.userCode,
          verificationUri: result.verificationUri,
          browserOpened: result.browserOpened,
          clipboardCopied: result.clipboardCopied,
          instruction:
            "请在打开的 GitHub 页面输入验证码完成授权（验证码已复制到剪贴板）。授权后调用 copilot_login_check 确认结果。",
        });
      } catch (error) {
        return textResult({ ok: false, error: errorMessage(error) });
      }
    },
  );

  server.registerTool(
    "copilot_login_check",
    {
      title: "查询登录进度",
      description: "查询设备码登录的后台进度：pending / complete / failed。complete 时已自动换取令牌并拉取模型列表。",
      inputSchema: z.object({}),
    },
    async () => {
      const state = loginState();
      if (state.status === "complete") {
        return textResult({ status: "complete", modelCount: state.modelCount, nextStep: "调用 copilot_setup 完成一键接入。" });
      }
      if (state.status === "failed") {
        return textResult({ status: "failed", error: state.error, nextStep: "调用 copilot_login 重新开始登录。" });
      }
      if (state.status === "pending") {
        return textResult({
          status: "pending",
          userCode: state.userCode,
          verificationUri: state.verificationUri,
          nextStep: "等待用户在浏览器完成授权，约 20 秒后再次调用 copilot_login_check。",
        });
      }
      return textResult({ status: "idle", nextStep: "当前没有进行中的登录，调用 copilot_login 开始。" });
    },
  );

  server.registerTool(
    "copilot_logout",
    {
      title: "退出登录",
      description: "清除本地 GitHub Copilot 凭据（不影响已注册的 ZCode 提供商配置；后者用 copilot_remove 移除）。",
      inputSchema: z.object({}),
    },
    async () => {
      await logout();
      return textResult({ ok: true, message: "已清除 GitHub Copilot 凭据。" });
    },
  );

  server.registerTool(
    "copilot_models",
    {
      title: "列出订阅可用模型",
      description: "实时拉取当前 Copilot 订阅的可用模型（含家族分类与 policy 状态）。",
      inputSchema: z.object({}),
    },
    async () => {
      try {
        await importFromPiIfAvailable();
        const credential = await ensureFreshCredential();
        const catalog = await fetchCopilotModels(credential.access, credential.enterpriseDomain);
        return textResult({
          availableModelIds: catalog.availableModelIds,
          models: catalog.models.map((model) => ({
            id: model.id,
            family: modelFamily(model.id),
            name: model.name,
            vendor: model.vendor,
            policyState: model.policyState,
            pickerEnabled: model.pickerEnabled,
          })),
        });
      } catch (error) {
        return textResult({ ok: false, error: errorMessage(error) });
      }
    },
  );

  server.registerTool(
    "copilot_setup",
    {
      title: "一键接入 ZCode",
      description:
        "完成接入：确保本地代理运行 → 检查登录（可自动导入 pi 凭据）→ 拉取全部可用模型并启用 → 把 copilot-claude / copilot-gpt 等提供商写入 ZCode 配置（自动备份）。完成后在 ZCode 模型选择器中即可选择 Copilot 模型。",
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const summary = await runSetup();
        return textResult(summary);
      } catch (error) {
        return textResult({ ok: false, error: errorMessage(error) });
      }
    },
  );

  server.registerTool(
    "copilot_remove",
    {
      title: "移除 ZCode 提供商配置",
      description: "从 ~/.zcode/v2/provider_config.json 移除本插件写入的全部提供商条目（写入前自动备份）。Copilot 登录凭据保留。",
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const result = await removeCopilotProviders();
        return textResult({ ok: true, ...result });
      } catch (error) {
        return textResult({ ok: false, error: errorMessage(error) });
      }
    },
  );

  // 启动时顺带确保代理 daemon 在跑（健康检查失败才拉起，不阻塞握手）。
  setTimeout(() => {
    ensureDaemon().catch(() => undefined);
  }, 200);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  console.error("zcode-copilot MCP server failed:", error);
  process.exit(1);
});
