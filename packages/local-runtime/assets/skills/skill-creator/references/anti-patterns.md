# Anti-Patterns — Mavis 实际见过的 skill 反例

> 这份清单不是从外部抄的，是从 Mavis 项目里见过的真实 skill 失败案例提炼的。每条都标注"为什么是反模式 + 该怎么改"。

## 1. 默认建 `.env` / `.env.example` / `.gitignore`

**反例来源**：旧版 `{{DATA_DIR}}/skills/skill-creator/SKILL.md` 把 `.env.example` 当 default scaffold。

**为什么是反模式**：
- 大多数 skill 不需要外部凭证（如 `pdf`、`mavis`）
- 凭空建 `.env` 给用户错觉"必须配置"
- `.gitignore` 是仓库级关心，不该放进 skill 包

**怎么改**：只有 skill 实际需要 API key 等外部凭证时才建。skill 创建时主动确认"需要外部配置吗？"

## 2. 把 README.md / CHANGELOG.md / INSTALLATION.md 塞进 skill 目录

**反例来源**：从外部 marketplace 导入的 skill（如某些 ClawHub skill），同目录有 5 个 `.md` 文件。

**为什么是反模式**：
- skill 目录是给 LLM 读的，不是给人看的产品文档
- README/CHANGELOG/INSTALLATION 是面向人类用户的，挤占模型 context
- 模型不知道该不该读这些文件，浪费 token

**怎么改**：skill 包里只放 LLM 执行需要的文件。版本演进信息放在 git history，使用说明写在 SKILL.md 的 `When to use` 里。

## 3. 用 ALWAYS / NEVER / MUST 把模型限死

**反例**：
```markdown
## Procedure
1. ALWAYS read the entire codebase first
2. NEVER use any tool other than Read
3. MUST output JSON
```

**为什么是反模式**：
- 模型读了大量 ALWAYS/NEVER 后会过拟合到字面规则，丢失判断力
- 不解释 why，模型遇到边界情况只能僵硬执行或直接放弃
- 遇到合理特例（如"这次需要一个小补丁，不需要读整个 codebase"）模型会卡住

**怎么改**：写"为什么这么做"和"不这么做的后果"。例：
```markdown
1. 先读 codebase 大致结构（避免凭空假设导致改错文件）
2. 优先用 Read，必要时也可以用 Grep（Read 慢但准，Grep 快但可能漏匹配）
3. 输出 JSON 格式，因为下游脚本会解析；如果 JSON 不合适（比如纯叙述性回答），改用 markdown 但要在最后明确说"输出格式：markdown"
```

## 4. description 只堆关键词

**反例**：
```yaml
description: PDF, text, extract, OCR, parse, document, file, read
```

**为什么是反模式**：
- 没说"什么时候用"，LLM 看了关键词命中就触发，不管语境
- 没说"什么时候不用"，会和近义 skill（如 pdf）冲突触发

**怎么改**：见 `description-rubric.md`，必须含 What + When + Near misses。

## 5. 一个 skill 包里塞多个 sub-skill / 多个 sub-agent

**反例**：从外部抄来的 skill，目录里有 `agents/`、`sub-skills/`、`commands/`、`hooks/` 全套。

**为什么是反模式**：
- skill 是单一能力包，不是 mini-platform
- 多 sub-skill 增加触发歧义，LLM 不知道该激活哪个
- Mavis 已经有 Team Engine 处理多 agent 协作，skill 内部不需要再造一套

**怎么改**：一个 skill 一个明确能力。需要协作多 agent 用 Team Engine plan，不要塞进 skill 内部。

## 6. SKILL.md 超长（>500 行），全部塞主文件

**反例来源**：一些社区 skill SKILL.md 写到 1000+ 行，包含 11 个思考模型 / 4-tier 复杂度等元理论。

**为什么是反模式**：
- 触发 skill 后这 1000 行全进 context，挤压用户对话空间
- 大量元理论是写给 skill 作者看的，不是给执行的 LLM

**怎么改**：SKILL.md 主体 ≤ 500 行，把详细参考拆 `references/<topic>.md`，主文件用"详见 references/foo.md"引用。LLM 需要时再读。

## 6.5 把 SKILL.md 写成 README / 教程 / API 文档

**反例**：主文件里充满 "What this tool does"、"How it works"、"Command line usage"、"As a Python module"，外加一长串示例命令。

**为什么是反模式**：
- skill 是给另一个模型执行的，不是给人类读产品说明
- 背景介绍、功能导览、模块示例会稀释真正重要的执行规约
- 这类内容最容易和 frontmatter 里的触发信息重复，白白占 context

**怎么改**：
- `description` 负责回答 "什么时候触发 / 什么情况别触发"
- 正文只保留 procedure / output contract / failure handling / 极少量 canonical examples
- 需要细节时，优先让模型读脚本、`--help` 或 `references/`

## 7. 用 Python 工具链（与 Mavis 生态不一致）

**反例**：从外部抄来的 skill 自带 `requirements.txt`、Python 脚本、需要 `pip install` 的依赖。

**为什么是反模式**：
- Mavis daemon / CLI 是 Node.js / TypeScript ESM
- 引入 Python 依赖增加用户环境复杂度
- 大多数 skill 需要的脚本（校验、聚合）用 Node.js + 内置 fs 就够

**怎么改**：脚本用 Node.js 写，不依赖第三方 npm 包（除非是 Mavis 本来就装了的）。

## 8. 抄外部 skill 的脚本/模板/schema 直接放进 Mavis

**反例**：把上游 skill-creator 的 `quick_validate.py` / `evals.json` schema 复制改名直接用。

**为什么是反模式**：
- 外部 schema 是按外部生态设计的（Python/外部 coding agent），可能与 Mavis 不兼容
- 抄过来即使能跑也是"陌生外科器官"——后续维护不知道为什么这么写
- Mavis 自己的语境（Team Engine、scratchpad、agent system）需要不同的设计

**怎么改**：思想可以借鉴，但每个文件都按 Mavis 实际需要原创实现。详见 `when-to-bundle-scripts.md`。

## 9. 不解释"为什么这个 skill 存在"

**反例**：frontmatter `description` 很弱，正文也直接进入 `## Procedure`，导致触发边界不清。

**为什么是反模式**：
- LLM 是否打开 skill 主要看 `description`
- 如果 `description` 没讲清能力边界和 near misses，模型可能漏触发或误触发

**怎么改**：先把 What / When / Near misses 写进 `description`。正文只在确实需要时补充输入要求，不要再复制一遍触发列表。

## 10. 默认依赖外部安装脚本 / install.sh

**反例**：`install.sh` 自动改用户的 `~/.bashrc` / `~/.zshrc`。

**为什么是反模式**：
- skill 是协议产物，不该有副作用
- 用户对修改 shell config 极度敏感
- Mavis 自己会发现并加载 skill，不需要 install 脚本

**怎么改**：skill 包里不放 install.sh。如果真需要外部依赖，在 SKILL.md 的 `## Setup`（仅本次需要时才有这一节）里明确写"请手动 X"。

## 11. Shell 命令只写 bash 版本，不做 Windows 适配

**反例来源**：早期 skill 只写 `python3 scripts/xxx.sh | grep "Page size"` 这类 bash 命令，Windows 用户跑不起来。

**为什么是反模式**：
- Mavis 在 Windows 上直接用 PowerShell 执行命令，没有 Unix 兜底层
- `python3`（Windows 上通常是 `python`）、`grep`、`sed`、`/tmp/` 等在 PowerShell 里不存在或行为不同
- 用户不应该为了跑一个 skill 还要自己翻译命令

**怎么改**：如果 skill 包含 shell 命令、脚本调用或 `python3` 引用，加 `## Windows (win32) platform notes` 段落，提供 PowerShell 等价命令或跨平台替代方案。纯流程 skill 可跳过。
