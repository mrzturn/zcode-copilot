# zcode-copilot

在 [ZCode](https://z.ai) 中使用你的 **GitHub Copilot 订阅** 模型（Claude / GPT / Grok / Gemini / Kimi 等），体验接近 [pi](https://github.com/badlogic/pi-mono) 的 `/login` 丝滑程度。

## 工作原理

ZCode 插件无法直接注册模型提供商，但支持「个人自定义提供商」（OpenAI / Anthropic 兼容端点 + 静态 API Key）。而 Copilot 的令牌是短期的（约 30 分钟过期）且需要 GitHub OAuth，因此本插件：

```
ZCode ──(OpenAI/Anthropic 协议)──▶ 本地代理 daemon (127.0.0.1:48911)
                                      │  注入 Bearer Copilot 令牌（自动刷新）
                                      │  注入 Copilot 必需身份头 / 动态头
                                      ▼
                        https://api.*.githubcopilot.com
```

1. **MCP 服务器**（插件提供）：设备码登录 GitHub → 换取 Copilot 令牌 → 拉取订阅模型 → 一键把提供商写入 ZCode 配置。
2. **本地代理 daemon**：detached 常驻进程，负责令牌自动刷新与协议转发，SSE 流式透传。
3. **ZCode 提供商**：`GitHub Copilot (Claude)`（anthropic-messages）、`GitHub Copilot (GPT/Grok)`（openai-responses）、`GitHub Copilot (OpenAI Chat)`（openai-chat-completions）。

凭据存于 `~/.zcode-copilot/auth.json`（0600）。若本机 [pi](https://github.com/badlogic/pi-mono) 已登录过 Copilot，会自动导入，无需重新登录。

## 安装

```bash
npm install && npm run build   # 或直接使用已提交的 dist/
```

将本仓库作为本地 marketplace 添加到 ZCode 并安装插件（或直接用 `/plugin` 添加本目录），详见下方「本地安装」。

## 使用

在 ZCode 中输入 `/copilot`，按引导完成：

1. **登录**：`copilot_login` 发起设备码流程（自动打开浏览器、复制验证码），`copilot_login_check` 查询进度。
2. **一键接入**：`copilot_setup` 启动代理、拉取订阅全部可用模型（自动 policy enable）、写入 ZCode 提供商配置（自动备份到 `provider_config.json.bak-*`）。
3. **使用**：在 ZCode 模型选择器的个人提供商分组中选择 `GitHub Copilot (Claude)` 等提供商下的模型。

### MCP 工具

| 工具 | 作用 |
|---|---|
| `copilot_status` | 登录态 / 令牌有效期 / daemon 健康 / 已注册提供商 |
| `copilot_login` | 发起设备码登录（立即返回验证码） |
| `copilot_login_check` | 查询登录进度 |
| `copilot_logout` | 清除本地凭据 |
| `copilot_models` | 实时拉取订阅可用模型 |
| `copilot_setup` | 一键接入（daemon + 模型 + 提供商配置） |
| `copilot_remove` | 移除写入 ZCode 的提供商配置（保留登录） |

### 调试 CLI

```bash
node dist/cli.mjs status          # 总览
node dist/cli.mjs login           # 命令行登录
node dist/cli.mjs models          # 模型列表
node dist/cli.mjs setup           # 一键接入
node dist/cli.mjs remove          # 移除提供商配置
node dist/cli.mjs daemon start|stop|status
```

日志：`~/.zcode-copilot/daemon.log`。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `ZCODE_COPILOT_PORT` | `48911` | 代理端口 |
| `ZCODE_COPILOT_HOME` | `~/.zcode-copilot` | 数据目录（凭据/日志） |
| `ZCODE_PROVIDER_CONFIG_FILE` | `~/.zcode/v2/provider_config.json` | ZCode 提供商配置路径 |

## 已验证能力

- Claude（anthropic-messages）：流式、工具调用、思考档位（adaptive thinking，low~max）
- GPT/Grok（openai-responses）：流式、函数调用、reasoning effort（none~max 按模型）
- gemini / kimi（openai-chat-completions）：流式、reasoning_effort（gemini 返回思考文本）
- **模型元数据来自 /models 声明**：思考档位（capabilities.supports.reasoning_effort）、上下文窗口与输出上限（capabilities.limits）、视觉/PDF 能力均按官方声明写入，声明缺失即视为不支持思考
- Claude 关闭思考机制逐模型实测（5.5 需 between_tools、4.x 接受 disabled、opus-5.5 只能省略字段）
- 令牌临期自动刷新（提前 5 分钟，单飞）
- 企业版账号自动推导 API 域名（token 内 `proxy-ep`）

## 范围外（后续）

- GitHub Enterprise 域名登录（参数已预留）
- 非 Copilot 订阅的 GitHub Free 账号

## 致谢

GitHub Copilot 接入协议参考了 [pi（badlogic/pi-mono）](https://github.com/badlogic/pi-mono) 的实现。

## License

Apache-2.0
