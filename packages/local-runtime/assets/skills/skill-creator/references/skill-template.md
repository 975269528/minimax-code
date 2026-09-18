# Skill Template — Mavis 自己的 SKILL.md 骨架

> 这是一个用于参考的填空模板，不是一份"应当死板套用"的格式。先理解每个章节存在的理由，然后再决定本次 skill 是否需要它。

## Frontmatter

```yaml
---
name: <kebab-case-name>     # 必填，与目录同名
description: |              # 必填，触发面，是 LLM 决定要不要打开 skill 的依据
  一句话能力 + 具体触发场景 + 不该触发的相邻情况
---
```

`description` 见 `description-rubric.md`。

## 正文章节（推荐顺序）

原则：`description` 负责触发；正文负责执行。不要把同一批触发条件在 body 里再写一遍。

```markdown
# <Skill Name>

## Inputs to collect
- 调用 skill 之前 LLM 要先问用户/读上下文确认的信息
- 没有这一节，模型会用错误假设硬上

## Procedure
- 步骤动作（祈使句）
- 每个步骤说"这样做的原因"，不是只给命令
- 步骤里禁止写 ALWAYS / NEVER；写"为什么这么做"和"不这么做的后果"

## Output contract
- 这个 skill 应该输出什么形式
- 文件、消息、还是结构化数据

## Failure handling
- 失败应该怎么办：放弃、降级、回报用户
- 容易卡的地方提前打预防针

## Examples
- 真实例子（input → output），不是虚构的 placeholder
- 1-2 个就够，不要写 5 个
```

可选章节：`Inputs to collect`。如果 skill 输入非常直接，可以省略。

可选章节：`## Windows (win32) platform notes`。如果 skill 包含 shell 命令、脚本调用或 `python3` 引用，加一个 Windows 适配段落，提供 PowerShell 等价命令或跨平台替代方案。纯流程 skill（无 shell 命令）可跳过。

不推荐章节：`When to use this skill`。触发条件应放进 frontmatter `description`，避免重复占用 context。

## 模板示例：填空版

下面是一个虚构的 `db-migrator` skill 用本模板填出来的样子：

```markdown
---
name: db-migrator
description: |
  Generate and apply Postgres schema migrations. Use when the user asks to
  "add a column", "migrate the database", "alter a table" or describes a
  schema change. Do NOT use for one-off SQL queries (use direct psql instead).
---

# DB Migrator

## Inputs to collect
- 目标表名（用户没说就问）
- 变更类型与具体字段
- 是否需要在生产环境跑（影响是否要 wrap in transaction）

## Procedure
1. 读 `migrations/` 目录确认下一个序号
   原因：避免序号冲突
2. 用模板生成 up/down SQL
   原因：down migration 是回滚保险
3. 在本地 docker postgres 上 dry run
   原因：catch 语法错误，不污染真实数据库

## Output contract
- 一个文件 `migrations/NNNN_<description>.sql`
- 包含 `-- up` 和 `-- down` 两段

## Failure handling
- dry run 失败 → 报错给用户，不要尝试自动修复 SQL
- 序号冲突 → 跳号，不要覆盖

## Examples
Input: "给 users 表加一个 last_login_at timestamp"
Output: 创建 `migrations/0042_add_users_last_login_at.sql`
```

## 写作约束清单

- 正文 ≤ 500 行；超出就拆 `references/<topic>.md` 然后用 `详见 references/...` 引用
- 正文优先写执行动作、输出约束、失败处理；不要写 README 式背景介绍、功能导览、模块化 API 教程
- 触发条件和 near misses 放 frontmatter `description`，不要在正文重复列一遍
- 示例保留 1-2 个 canonical case；其余让模型通过脚本 `--help`、引用文件或代码自查
- 假设读者是另一个模型，不假设它已知项目背景
- 如果某段是写给人类看的（教学/历史背景），明确标注，避免污染模型 context
- 章节顺序可以调，但前几节必须快速回答：要补什么输入、怎么执行、失败怎么办
