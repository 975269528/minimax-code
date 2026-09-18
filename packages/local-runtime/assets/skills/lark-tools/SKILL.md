---
name: lark-tools
description: >-
  Feishu/Lark full-capability access via the official `lark-cli` (terminal) plus native
  local-runtime Feishu channel binding/status. Use this skill whenever the user mentions anything
  related to Feishu or Lark, including but not limited to: checking today's schedule or a specific
  date's agenda, creating calendar events, querying free/busy status, viewing or creating tasks,
  searching group chats, reading chat history, sending or replying to messages, looking up contacts
  or user details, querying or writing Bitable (multi-dimensional table) records, searching
  documents, or running any lark-cli subcommand. ALSO use this skill to READ or OPEN a Feishu/Lark
  document, wiki, sheet, or Base from a link — any `feishu.cn`, `larksuite.com`, or `*.feishu.cn`
  URL (including `/docx/`, `/wiki/`, `/sheets/`, `/base/`, `/w000/`, `/file/` paths), even when the
  user just pastes the bare URL without saying "Feishu". Route by link type, NOT `webfetch`: a
  doc/docx/wiki link → `lark-cli docs +fetch` (it resolves both docx and wiki URLs); a `/sheets/`
  link → `lark-cli sheets +read`; a `/base/` (Bitable) link → `lark-cli base +record-list`. Feishu
  serves an anti-bot/ad page to plain HTTP fetchers, so `webfetch` on a `feishu.cn` /
  `larksuite.com` URL returns garbage; switch to this skill when that happens. Even if the user
  simply says "check my schedule", "send a message to someone", "find a doc about X", "read this
  feishu doc", or "look up who Zhang San is", this skill applies. Also use it when encountering 401
  / LARK_USER_AUTH_REQUIRED errors — this skill handles the auth flow.
descriptions:
  zh-Hans: '通过官方 lark-cli 使用飞书/Lark 全能力，包括日程、任务、消息、通讯录、文档和多维表格；读取/打开任何 feishu.cn / larksuite.com 链接（即使只粘贴裸链接）请按类型路由、不要用 webfetch（飞书反爬会返回广告页）：文档/docx/wiki 用 docs +fetch，表格用 sheets +read，Base 用 base +record-list。'
---

# Feishu / Lark Tools

Run Feishu (Lark) operations by invoking the official `lark-cli` binary directly from the terminal.
User credentials live in the global `~/.lark-cli/` store. Bot credentials are bound through native
local-runtime Feishu channel config — no daemon proxy or per-bot HOME is needed.

The local runtime owns two responsibilities:

1. **Bot binding** — persisting an existing Feishu app's `appId` / `appSecret` to the native channel
   binding store for the selected agent.
2. **Bot status** — surfacing whether a Feishu bot is bound and which agent it targets.

User OAuth (UAT) is **not** a long-running runtime responsibility. Run
`lark-cli auth login --recommend` for the bound app when user-scoped APIs are needed, and use
`lark-cli auth login --scope "..."` directly when an operation first hits a missing-scope error.

Everything else (calendar, IM, base, docs, tasks, …) is a plain `lark-cli` invocation.

## Reading a Feishu/Lark link (do NOT use webfetch)

When the user pastes or references a Feishu/Lark URL — any `feishu.cn`, `*.feishu.cn`, or
`larksuite.com` link, including `/docx/`, `/wiki/`, `/sheets/`, `/base/`, `/wiki/space/`, or
`/file/` paths — read its content with `lark-cli`, never with `webfetch`:

- **Document / wiki**: `lark-cli docs +fetch --doc "<url>"` (resolves both `/docx/` and `/wiki/`
  URLs; see `cli-skills/lark-doc/`).
- **Sheet**: `lark-cli sheets +read` (see `cli-skills/lark-sheets/`).
- **Base / Bitable**: `lark-cli base +record-list` (see `cli-skills/lark-base/`).

Why not `webfetch`: Feishu blocks plain HTTP fetchers with an anti-bot / ad page, so `webfetch`
on a `feishu.cn` URL returns a useless ad GIF or challenge page rather than the document. This is
the same domain-routing pattern as `x-link-reader` (x.com → FxTwitter): a Feishu link belongs to
`lark-cli`, not the generic web fetcher. If you already tried `webfetch` and got an anti-bot/ad
page, switch to `lark-cli docs +fetch` and retry.

### Direct link fast path

For a read-only `/docx/` or `/wiki/` link, call the documented command directly:

```text
lark-cli docs +fetch --doc "<url>" --format json
```

Do not preflight this direct route with `which`, `command -v`, `where`, `Get-Command`,
`lark-cli --version`, `lark-cli help`, installation checks, bot-binding checks, or a separate auth
status call. The requested command is the capability check and the shortest correct path. Only if
that command actually returns command-not-found, authentication/authorization required, or a
missing-scope error should you enter the corresponding install or auth recovery below. Do not
repeat a successful `docs +fetch` through another Lark command.

## Mandatory platform command router

`lark-cli` itself is cross-platform, but the setup glue in this skill (installing `lark-cli`,
checking auth JSON, and binding a Feishu bot with `mavis im channel bind`) is shell-specific. Before
running any setup command, select exactly one platform command reference and use only that file's
recipes.

Router:

1. Read `<agent-context>.platform`.
2. If `platform` is `win32`:
   - REQUIRED: read `references/commands-windows-powershell.md`.
   - Use PowerShell recipes from that file only (`ConvertFrom-Json`, `Invoke-RestMethod`,
     `Join-Path`, etc.).
   - Do NOT use bash snippets, `command -v`, `cat`, `sed`, or `jq` pipelines.
3. If `platform` is `darwin` or `linux`:
   - REQUIRED: read `references/commands-macos-linux.md`.
   - Use bash/zsh recipes from that file only.
4. If `platform` is missing or unknown:
   - Do a tiny preflight to identify the shell/platform before running anything.
   - If still unclear, ask the user which environment is running the command.

Never translate shell commands across platforms from memory. The platform reference files own every
recipe for `install-lark-cli`, `bot-status`, `auth-status`, and `bind-feishu-bot`. The body of this
skill keeps the high-level flow; the reference files keep the platform-specific glue.

## Quick Start for operations without a direct-link fast path

0. **Ensure `lark-cli` is installed after command-not-found** — see [Install lark-cli](#install-lark-cli)
1. **Check bot binding** — ensure a Feishu bot is connected to the agent
2. **Check user auth** — ensure the user has authorized via OAuth
3. **Run lark-cli** — see [Calling lark-cli](#calling-lark-cli) and the per-domain sub-skills

## Install lark-cli

`lark-cli` is the official Feishu/Lark CLI binary that this skill drives. It is **not** bundled with
mavis and is not installed by default. For the direct-link fast path, run the requested command
without a separate installation probe. For other operations, or after a real command-not-found
error, use the `install-lark-cli` recipe from the selected platform command reference; if missing,
install it for the user before retrying the requested command.

The npm package is **`@larksuite/cli`** (provides the `lark-cli` binary). Do not guess other package
names.

Notes:

- If the global install fails with a permission error, tell the user and offer either an elevated
  install (e.g. `sudo npm install -g @larksuite/cli` on macOS/Linux, or running PowerShell as
  Administrator on Windows) or a per-user prefix. **Never run `sudo` without telling the user
  first.**
- After install, do **not** run `lark-cli config init` unless you explicitly need to initialize the
  official CLI store outside Mavis. Bot binding in Mavis is handled by local-runtime channel config.
- For upgrades after first install, see the update notice handling in
  `cli-skills/lark-shared/SKILL.md` (`npm update -g @larksuite/cli`).

## Bot Binding

Before any Feishu operation, verify that a Feishu bot is connected. Without a bot, the global
lark-cli store has no Feishu app credentials and `lark-cli api ...` cannot make API calls.

### Check connection status

Use the `bot-status` recipe from the selected platform command reference. It runs
`lark-cli auth status` and parses the JSON result with the platform-native parser (`jq` on
macOS/Linux, `ConvertFrom-Json` on PowerShell).

- **No output / no `appId`** — no app is bound, proceed to register a new bot below.
- **`appId` present, `identity: "bot"`** — bot is bound but the user has not authorized (or the UAT
  expired). Jump to [User Authentication](#user-authentication).
- **`appId` present, `identity: "user"`, `tokenStatus: "valid"`** — fully ready, proceed with the
  user's request. Check the `scope` field to confirm the requested operation's permission is
  included.

### Bind a Feishu bot

If no bot is bound, ask the user for an existing Feishu app's `appId` and `appSecret`, then use the
`bind-feishu-bot` recipe from the selected platform command reference. It runs:

```bash
mavis im channel bind <agent> --platform feishu --app-id <appId> --app-secret <appSecret>
```

The local runtime persists the credentials in the native Feishu channel store and connects the bot
to the channel runner. The bot is live without restarting local-runtime.

## User Authentication

User credentials live in the global lark-cli store, keyed by `(appId, userOpenId)` and shared with
the terminal `lark-cli`. The actual on-disk paths differ per platform — see
`references/storage-paths.md` for the per-OS table; this skill never assumes any specific host OS
path.

After bot binding, run `lark-cli auth login --recommend` when user-scoped calls are needed. The
resulting UAT is stored in the official global `lark-cli` store and reused by terminal commands.

**Increments** happen lazily: when a specific call requires a scope the current UAT does not have (a
high-sensitivity scope outside `--recommend`), `lark-cli` prints the exact
`lark-cli auth login --scope "..."` invocation needed; rerun with that suggestion and the new UAT is
written into the same global store on success. Do **not** re-run `--recommend` to "refresh" — it
will pop another auth window for the user without adding any scope.

### Check auth status

Use the `auth-status` recipe from the selected platform command reference. It runs
`lark-cli auth status` and parses the JSON with `jq` (macOS/Linux) or `ConvertFrom-Json`
(PowerShell), returning the same
`{appId, identity, userOpenId, userName, tokenStatus, scope, expiresAt}` shape.

If `identity == "user"` and `tokenStatus == "valid"` and the requested operation's scope is in the
`scope` field, auth is valid — proceed with the user's request. Otherwise run `lark-cli auth login`
(see [User Authentication](#user-authentication)).

To actually call the server (catches stale-but-not-yet-expired tokens), use
`lark-cli auth status --verify`. It returns the same JSON plus `verified: true|false`.

### Interop with the terminal `lark-cli`

Because local-runtime channel binding and official `lark-cli` user auth are separate:

- Bot credentials are stored by local-runtime with `mavis im channel bind`.
- User OAuth tokens are stored by the official `lark-cli`.
- After the user runs `lark-cli auth login --scope "..."` in the terminal to add an extra scope,
  subsequent terminal calls use the newly-issued UAT automatically.
- `lark-cli config init` is only needed if the official CLI store has not been initialized for
  direct terminal use; do not hand-edit `~/.lark-cli/config.json`.

## Calling lark-cli

**MANDATORY: Before running any `lark-cli` shortcut (`+messages-send`, `+chat-search`, `+agenda`,
etc.), you MUST Read the corresponding sub-skill reference file first.** The examples below are just
a starting point — they do NOT cover formatting caveats, content flags (`--text` vs `--markdown` vs
`--content`), or identity requirements. The reference files contain critical details that, if
missed, cause silent data loss (e.g. empty messages, wrong format).

Use the Sub-Skills Index below to find the right reference file for each shortcut.

Once auth is in place, invoke `lark-cli` directly. Use `--as user` for personal resources (calendar
/ drive / tasks) and `--as bot` for application-level operations (inbound IM / event subscribe). The
per-domain sub-skills under `cli-skills/` document concrete command syntax; the cheat sheet below is
just a starting point.

```bash
# Generic OpenAPI passthrough (works for any documented Feishu endpoint)
lark-cli api GET  /open-apis/contact/v3/users/<user_id> --as user
lark-cli api POST /open-apis/im/v1/messages --as bot --params '{"receive_id_type":"chat_id"}' --data '{...}'

# Calendar — today's agenda + create event
lark-cli calendar +agenda --as user --format json
lark-cli calendar +create --as user --summary "Team Sync" --start 2026-04-01T14:00 --end 2026-04-01T15:00

# IM — search chats, list messages, send / reply
lark-cli im +chat-search          --as user --query "周报" --format json
lark-cli im +chat-messages-list   --as user --chat-id oc_xxx --format json
lark-cli im +messages-send        --as bot  --chat-id oc_xxx --markdown "Hello"
lark-cli im +messages-reply       --as bot  --message-id om_xxx --markdown "Reply"

# Task / Base / Contact — same pattern
lark-cli task    +get-my-tasks    --as user --format json
lark-cli base    +record-list     --app-token bascnXXX --table-id tblXXX --format json
lark-cli contact +search-user     --as user --query "张三" --format json
```

Most subcommands print JSON when you pass `--format json`; pipe to `jq` to extract fields. A few
commands print JSON unconditionally (e.g. `lark-cli auth status`, `lark-cli auth list`) — no
`--format` flag needed for those.

**Multi-bot environments** — when multiple bots are bound, pass `--as user --app-id <appId>` (or use
`lark-cli auth use <appId>` to switch the default) to disambiguate. With a single bot, the only
entry in `apps[]` is auto-selected.

## Sub-Skills Index (Load on Demand)

Each entry maps to `cli-skills/<name>/SKILL.md`. **Before using any sub-skill, you MUST first Read
`cli-skills/lark-shared/SKILL.md`** — it covers the cross-cutting basics (identity selection, scope
concepts, permission-denied handling, security rules) and now aligns with the mavis flow described
above (local-runtime owns Feishu bot binding; `lark-cli` owns user OAuth with `--recommend` or
targeted `--scope`, never `--domain`).

**Then Read the specific sub-skill's reference file** for the shortcut you're about to use (e.g.
`cli-skills/lark-im/references/lark-im-messages-send.md` before calling `+messages-send`). Do NOT
rely on the quick examples above — they omit critical formatting and content-flag details.

| Scenario keywords                                                                   | Sub-skill                     | Path                                                |
| ----------------------------------------------------------------------------------- | ----------------------------- | --------------------------------------------------- |
| Calendar / agenda / meeting room / free-busy / RSVP                                 | lark-calendar                 | `cli-skills/lark-calendar/SKILL.md`                 |
| Tasks / todos / lists / assignments                                                 | lark-task                     | `cli-skills/lark-task/SKILL.md`                     |
| Send/receive messages / group chats / chat history / upload-download images & files | lark-im                       | `cli-skills/lark-im/SKILL.md`                       |
| Contacts / find people / lookup open_id / departments                               | lark-contact                  | `cli-skills/lark-contact/SKILL.md`                  |
| Create / edit / read Feishu cloud documents                                         | lark-doc                      | `cli-skills/lark-doc/SKILL.md`                      |
| Drive file management / upload-download / import docs / comments                    | lark-drive                    | `cli-skills/lark-drive/SKILL.md`                    |
| Spreadsheet read/write / export                                                     | lark-sheets                   | `cli-skills/lark-sheets/SKILL.md`                   |
| Bitable / Base / fields / records / views                                           | lark-base                     | `cli-skills/lark-base/SKILL.md`                     |
| Wiki / knowledge base / space members / nodes                                       | lark-wiki                     | `cli-skills/lark-wiki/SKILL.md`                     |
| Slides / PPT create and read                                                        | lark-slides                   | `cli-skills/lark-slides/SKILL.md`                   |
| Whiteboard                                                                          | lark-whiteboard               | `cli-skills/lark-whiteboard/SKILL.md`               |
| Whiteboard CLI advanced ops                                                         | lark-whiteboard-cli           | `cli-skills/lark-whiteboard-cli/SKILL.md`           |
| Email send/receive / drafts / rules / attachments                                   | lark-mail                     | `cli-skills/lark-mail/SKILL.md`                     |
| Video conference history / recordings                                               | lark-vc                       | `cli-skills/lark-vc/SKILL.md`                       |
| Minutes list / download / AI artifacts                                              | lark-minutes                  | `cli-skills/lark-minutes/SKILL.md`                  |
| Approval instances / tasks                                                          | lark-approval                 | `cli-skills/lark-approval/SKILL.md`                 |
| Attendance / clock-in records                                                       | lark-attendance               | `cli-skills/lark-attendance/SKILL.md`               |
| Real-time event subscription (WebSocket)                                            | lark-event                    | `cli-skills/lark-event/SKILL.md`                    |
| Find native un-wrapped OpenAPI                                                      | lark-openapi-explorer         | `cli-skills/lark-openapi-explorer/SKILL.md`         |
| Custom Skill authoring                                                              | lark-skill-maker              | `cli-skills/lark-skill-maker/SKILL.md`              |
| Bulk meeting minutes processing                                                     | lark-workflow-meeting-summary | `cli-skills/lark-workflow-meeting-summary/SKILL.md` |
| Agenda + todo standup digest                                                        | lark-workflow-standup-report  | `cli-skills/lark-workflow-standup-report/SKILL.md`  |
| Shared base (identity / scope / safety rules)                                       | lark-shared                   | `cli-skills/lark-shared/SKILL.md`                   |

**Loading examples**:

- User: "Show me today's schedule" → Read `cli-skills/lark-shared/SKILL.md` +
  `cli-skills/lark-calendar/SKILL.md`
- User: "Add a row to the Bitable" → Read `cli-skills/lark-shared/SKILL.md` +
  `cli-skills/lark-base/SKILL.md`

---

## Tips

- **Multi-bot environments** — when multiple bots are bound, disambiguate with `--app-id <appId>`
  (or `lark-cli auth use <appId>`). With one bot, it is auto-selected.
- **401 / LARK_USER_AUTH_REQUIRED** — the user's OAuth token is missing or expired. If the UAT is
  missing or expired, run `lark-cli auth login --recommend` (one-shot, recommended scope set). If a
  specific call needs an **extra** scope outside `--recommend`, `lark-cli` itself prints the exact
  `lark-cli auth login --scope "..."` invocation to use; rerun with that suggestion. **Do not use
  `--domain`** — it is per-domain and forces the user through a separate auth window for each module
  they touch.
- **Bitable requires tokens from the URL** — you need the `appToken` (from the table URL) and
  `tableId` (from `lark-cli base +table-list`).

## Windows note on cli-skills examples

The per-domain reference files in `cli-skills/` (lark-mail, lark-whiteboard, lark-slides, etc.) show
bash heredoc patterns like `cat > file << 'EOF'` for writing JSON payloads. On Windows:

- Use the **Write tool** (preferred) to write JSON content to a file, then pass the file path to
  `lark-cli`.
- Or use PowerShell with a multi-line here-string (the `@'` and `'@` tokens must each be on their
  own line):
  ```powershell
  @'
  {"key": "value"}
  '@ | Set-Content -Path ./patch.json -Encoding UTF8
  ```
- Or wrap in `bash -c "cat > file << 'EOF' ... EOF"` if Git Bash is available.

The `lark-cli` binary itself is cross-platform and works identically in both PowerShell and bash.
