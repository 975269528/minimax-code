# lark-tools Commands — macOS / Linux

Shell: bash or zsh. Use these recipes only on `darwin` / `linux` platforms.

Do not copy these snippets into Windows PowerShell. Windows has a separate reference:
`commands-windows-powershell.md`.

## install-lark-cli

```bash
if ! command -v lark-cli >/dev/null 2>&1; then
  echo "lark-cli not found, installing @larksuite/cli globally..."
  npm install -g @larksuite/cli
fi
lark-cli --version    # confirm install succeeded
```

If the install fails with `EACCES`, prefer a per-user prefix over `sudo` and tell the user before
escalating.

## bot-status

```bash
lark-cli auth status 2>/dev/null \
  | jq '{appId, identity, userOpenId, userName, tokenStatus, scope}'
```

## auth-status

```bash
lark-cli auth status 2>/dev/null \
  | jq '{appId, identity, userOpenId, userName, tokenStatus, scope, expiresAt}'
```

## bind-feishu-bot

```bash
mavis im channel bind "${AGENT_NAME:-main}" \
  --platform feishu \
  --app-id "${FEISHU_APP_ID}" \
  --app-secret "${FEISHU_APP_SECRET}"
```
