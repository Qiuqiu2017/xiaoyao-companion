# 小遥 · Xiaoyao Companion

Minecraft **Fabric 1.21.11** 的 AI 陪玩机器人。

- 以离线账号 `xiaoyao` 登录你的 LAN 世界
- 通过 DeepSeek / OpenAI 兼容接口聊天、跟随、走动
- **Fabric 模组**提供配置界面：可自选提供商、模型、思考强度、API Key
- 附带 `fixlan` 模组：让离线账号可以加入 1.21.11 的 LAN 世界

## 组成

| 目录 | 说明 |
| --- | --- |
| `bot.js` | 陪玩内核（Node.js + mineflayer），负责登录、聊天、跟随 |
| `fabric-mod/` | Meteor Client 附加模组 `xiaoyao-ai`，提供游戏内设置与启动/停止 |
| `fabric-mod/fixlan/` | 离线 LAN 修复模组（关闭集成服务器正版验证） |
| `dist/` | 构建产物（也可在 Releases 下载） |

> 小遥是一个独立进程：Fabric 模组负责配置与启动，真正进入游戏的是 `bot.js`。
> 这样可以以独立玩家身份登录，而不会影响你正在玩的客户端。

## 环境要求

- Minecraft 1.21.11 + Fabric Loader 0.19.x
- [Meteor Client](https://meteorclient.com/)（1.21.11 版本）
- Node.js 20+
- 世界需要通过「对局域网开放」开启，并保持开启

## 安装

1. 安装 Node 依赖：

   ```bash
   cd xiaoyao-companion
   npm install
   ```

2. 把 `dist/xiaoyao-ai-1.0.0.jar` 放进 `.minecraft/mods`。
3. 如果服务器是正版验证模式，把 `dist/fixlan-1.0.0.jar` 也放进 **主机** 的 `mods`。
4. 启动游戏，进入世界并「对局域网开放」。
5. 打开 Meteor Client 的 ClickGUI → **Misc → Xiaoyao AI**：
   - `provider`：DeepSeek / OpenAI / OpenRouter / SiliconFlow / Custom
   - `model`：模型 ID，默认 `deepseek-flash`
   - `thinking`：Off / Low / Medium / High / Max
   - `api-key`：你的 API Key（留空则读取环境变量或 opencode 配置）
   - `bot-path`：本仓库所在目录
   - `log-path`：Minecraft 的 `logs/latest.log`，用于自动识别 LAN 端口
6. 打开模块开关，小遥会自动加入。

## 直接运行（不使用模组）

```bash
cd xiaoyao-companion
npm install
XIAOYAO_CONFIG=config.json node bot.js
```

`config.json` 示例：

```json
{
  "provider": "deepseek",
  "baseUrl": "",
  "model": "deepseek-flash",
  "thinking": "max",
  "apiKey": "",
  "host": "127.0.0.1",
  "port": 0,
  "logPath": "",
  "username": "xiaoyao"
}
```

- `port` 为 0 时自动从 `logPath` 中的 `Started serving on <port>` 识别。
- `apiKey` 留空时依次读取 `DEEPSEEK_API_KEY`、`LLM_API_KEY`、`~/.local/share/opencode/auth.json`。
- `thinking` 会映射为请求里的 `reasoning_effort`；DeepSeek 额外开启 `thinking`。

## 安全提示

- API Key 会写入 `config.runtime.json` 与 Meteor 的设置文件，请勿把这两个文件发给别人。
- 离线 LAN 世界没有正版验证，拿到地址的人都能进入；请只分享给信任的人。
- 本项目不包含任何第三方模型权重或 API Key。

## License

MIT
