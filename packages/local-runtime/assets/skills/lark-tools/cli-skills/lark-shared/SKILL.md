---
name: lark-shared
version: 1.0.0
description:
  '飞书/Lark CLI 共享基础：应用配置初始化、认证登录（auth login）、身份切换（--as user/bot）、权限与
  scope 管理、Permission denied 错误处理、安全规则。当用户需要第一次配置(`lark-cli config
  init`)、使用登录授权(`lark-cli auth login`)、遇到权限不足、切换 user/bot 身份、配置
  scope、或首次使用 lark-cli 时触发。'
---

# lark-cli 共享规则

本技能指导你如何通过lark-cli操作飞书资源, 以及有哪些注意事项。

> **mavis 适配说明 (重要)**:
>
> - **绑定飞书 bot（首次使用、新机器）**：用
>   `mavis im channel bind <agent> --platform feishu --app-id <appId> --app-secret <appSecret>`
>   写入 local-runtime 原生 Feishu channel store（详见入口 `lark-tools/SKILL.md`）。
> - **首次用户身份授权（一次性拿到推荐 scope 全集）**：需要用户身份时，由 agent 运行
>   `lark-cli auth login --recommend`，UI/聊天里只展示授权 URL 给用户点击。
> - **运行时检测到缺 scope**：按 §[Agent 代理发起认证](#agent-代理发起认证)
>   的 canonical 模板执行（`--no-wait --json` 取 URL → 后台 `--device-code` 等用户）。**不要** curl
>   runtime、不要再用 `--domain`。仅在推荐 scope 集合之外的高敏感 scope 才会触发这条路径。
> - 本文件其余部分（身份选择原则、scope 概念、更新检查、安全规则）完全适用，无需特殊适配。

## 配置初始化

mavis 中**首次绑定 bot** 走 local-runtime channel bind（详见
`lark-tools/SKILL.md`）。`lark-cli config init` 只在官方 CLI
store 尚未初始化、且你需要直接运行 terminal `lark-cli` 时使用。

> 仅当 local-runtime 未绑定 Feishu bot 时才需要这一步；已有 appId 时跳过。

## 认证

### 身份类型

两种身份类型，通过 `--as` 切换：

| 身份          | 标识        | 获取方式                                                  | 适用场景                             |
| ------------- | ----------- | --------------------------------------------------------- | ------------------------------------ |
| user 用户身份 | `--as user` | `lark-cli auth login --recommend`（首次）+ `--scope` 增量 | 访问用户自己的资源（日历、云空间等） |
| bot 应用身份  | `--as bot`  | 自动，只需 appId + appSecret                              | 应用级操作,访问bot自己的资源         |

### 身份选择原则

输出的 `[identity: bot/user]` 代表当前身份。bot 与 user 表现差异很大，需确认身份符合目标需求：

- **Bot 看不到用户资源**：无法访问用户的日历、云空间文档、邮箱等个人资源。例如 `--as bot`
  查日程返回 bot 自己的（空）日历
- **Bot 无法代表用户操作**：发消息以应用名义发送，创建文档归属 bot
- **Bot 权限**：只需在飞书开发者后台开通 scope，无需 `auth login`
- **User 权限**：后台开通 scope + 用户通过 `auth login` 授权，两层都要满足

### 权限不足处理

遇到权限相关错误时，**根据当前身份类型采取不同解决方案**。

错误响应中包含关键信息：

- `permission_violations`：列出缺失的 scope (N选1)
- `console_url`：飞书开发者后台的权限配置链接
- `hint`：建议的修复命令

#### Bot 身份（`--as bot`）

将错误中的 `console_url` 提供给用户，引导去后台开通 scope。**禁止**对 bot 执行 `auth login`。

#### User 身份（`--as user`）

```bash
# 首次授权（推荐 / 默认动作）：一次性拿到飞书会自动批准的推荐 scope 全集
lark-cli auth login --recommend

# 增量授权：仅当报错说缺某个推荐范围之外的高敏感 scope 时使用
lark-cli auth login --scope "<missing_scope>"
```

**规则**：

- 首次或缺少基础能力时**默认走 `--recommend`**——一次过、飞书自动批、覆盖 80%+ 日常 domain。
- 仅当运行时报错明确缺**推荐范围之外**的 scope（如
  `contact:user:search`、`search:message`、`im:message.group_msg:get_as_user` 等高敏感 scope）才走
  `--scope` 增量。
- **不要再用 `--domain`**——按 domain 申请会让用户每用一个新模块就被弹一次授权，体验差。`--recommend`
  已经覆盖各 domain 的常用 scope。
- 多次 login 的 scope 会累积（增量授权），`--recommend` 之上再叠 `--scope` 是安全的。
- 在 mavis 中，local-runtime 负责 bot 绑定；用户 OAuth 仍由 `lark-cli auth login --recommend` 或增量
  `--scope` 完成。

#### Agent 代理发起认证

> **Hard rule**：禁止把 `lark-cli auth login`
> 整条命令贴给用户让他自己跑。你有 bash，命令你跑；用户只负责浏览器点同意按钮。

`lark-cli` 已为 AI agent 设计非交互模式：`--no-wait --json` 立即返回 `verification_url` +
`device_code`（不阻塞），再后台跑 `--device-code` 等用户完成。canonical 流程：

```bash
# 1) 启动 device flow，立即拿 verification_url（不阻塞，10 分钟有效）
#    缺基础 scope 用 --recommend；缺推荐之外的高敏感 scope 用 --scope "<name>"
RESP=$(lark-cli auth login --no-wait --json --scope "search:message")
URL=$(echo "$RESP"  | jq -r .verification_url)
CODE=$(echo "$RESP" | jq -r .device_code)

# 2) 把 URL 发给用户点同意（user_code 可一并给出便于核对）
echo "请点击授权链接：$URL"

# 3) 后台跑 device-code 等用户完成，token 自动落到全局 lark-cli store
nohup lark-cli auth login --device-code "$CODE" --json \
  > /tmp/lark-auth-$$.log 2>&1 &
disown
```

❌ 反例：把 `lark-cli auth login --scope "..."` 命令贴给用户、让他跑完把输出贴回来。

授权完成后 token 自动写入全局 lark-cli store（`~/.lark-cli/` +
`~/Library/Application Support/lark-cli/*.enc`），终端 lark-cli 后续直接复用。

## 更新检查

lark-cli 命令执行后，如果检测到新版本，JSON 输出中会包含 `_notice.update` 字段（含
`message`、`command` 等）。

**当你在输出中看到 `_notice.update` 时，完成用户当前请求后，主动提议帮用户更新**：

1. 告知用户当前版本和最新版本号
2. 提议执行更新（CLI 和 Skills 需要同时更新）：
   ```bash
   npm update -g @larksuite/cli && npx skills add larksuite/cli -g -y
   ```
3. 更新完成后提醒用户：**退出并重新打开 AI Agent**以加载最新 Skills

**规则**：不要静默忽略更新提示。即使当前任务与更新无关，也应在完成用户请求后补充告知。

## 安全规则

- **禁止输出密钥**（appSecret、accessToken）到终端明文。
- **写入/删除操作前必须确认用户意图**。
- 用 `--dry-run` 预览危险请求。
