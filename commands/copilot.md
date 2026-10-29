---
description: 接入/管理 GitHub Copilot 订阅模型（登录、状态、模型列表、一键接入、移除）
---

使用 `zcode_copilot` MCP 服务器的工具处理用户关于 GitHub Copilot 的请求。按以下流程操作，不要自己发明步骤：

## 首次接入（用户想接入 / 登录 / 使用 Copilot 模型）

1. 调用 `copilot_status` 查看当前状态。
2. 若未登录：
   - 调用 `copilot_login`，把返回的 **userCode（验证码）** 和 **verificationUri（验证链接）** 清晰地展示给用户（代码格式如 `XXXX-XXXX`），并告知浏览器已自动打开、验证码已复制到剪贴板。
   - 等待约 20 秒后调用 `copilot_login_check`；若返回 `pending` 则继续等待并重复检查；若 `failed` 则把错误展示给用户并建议重新 `copilot_login`。
   - 注意：若用户本机 pi 已登录过 Copilot，可跳过登录直接进入下一步（setup 会自动导入凭据）。
3. 调用 `copilot_setup` 一键完成接入（自动启动本地代理、拉取订阅全部模型、写入 ZCode 提供商配置并备份）。
4. 把 setup 返回的提供商与模型摘要告诉用户，并提示：**在 ZCode 底部模型选择器中选择 `GitHub Copilot (Claude)` / `GitHub Copilot (GPT/Grok)` 提供商下的模型即可使用**。

## 其他请求

- 查状态/令牌是否快过期 → `copilot_status`
- 看订阅有哪些模型 → `copilot_models`
- 移除接入（保留登录）→ `copilot_remove`
- 退出登录 → `copilot_logout`

## 故障排查

- 对话报 503「未登录」→ `copilot_status` 检查，必要时重新登录 + setup。
- 模型请求失败但登录正常 → 提示用户运行调试命令 `node <插件目录>/dist/cli.mjs status` 查看 daemon 与配置状态。
- ZCode 未出现 Copilot 模型 → 确认 `copilot_setup` 成功执行过；模型选择器在「个人提供商」分组下查找。
