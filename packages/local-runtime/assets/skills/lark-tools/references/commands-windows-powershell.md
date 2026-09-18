# lark-tools Commands — Windows PowerShell

Shell: Windows PowerShell 5.1+ or PowerShell 7+. Use these recipes only on `win32`.

Do not use bash syntax in PowerShell: no `command -v`, no `cat`, no `sed`, no `jq` pipelines, no
`2>/dev/null`. Prefer PowerShell cmdlets, `Join-Path`, and `ConvertFrom-Json`.

**Encoding**: Always pass `-Encoding UTF8` when using `Get-Content` or `Set-Content`. Windows
PowerShell 5.1 defaults to the system ANSI code page (e.g. GBK on Chinese Windows), which silently
corrupts UTF-8 content. Prefer Read/Write/Edit tools for file content operations.

## install-lark-cli

```powershell
if (-not (Get-Command lark-cli -ErrorAction SilentlyContinue)) {
  Write-Host "lark-cli not found, installing @larksuite/cli globally..."
  npm install -g @larksuite/cli
}
lark-cli --version    # confirm install succeeded
```

If the install fails because of permissions, prefer a per-user prefix over running PowerShell as
Administrator without telling the user first.

## bot-status

```powershell
$Status = (lark-cli auth status 2>$null) | ConvertFrom-Json
$Status | Select-Object appId, identity, userOpenId, userName, tokenStatus, scope
```

## auth-status

```powershell
$Status = (lark-cli auth status 2>$null) | ConvertFrom-Json
$Status | Select-Object appId, identity, userOpenId, userName, tokenStatus, scope, expiresAt
```

## bind-feishu-bot

```powershell
$AgentName = if ($env:AGENT_NAME) { $env:AGENT_NAME } else { "main" }
mavis im channel bind $AgentName `
  --platform feishu `
  --app-id $env:FEISHU_APP_ID `
  --app-secret $env:FEISHU_APP_SECRET
```

## Safety notes

- Use `Invoke-RestMethod` instead of `curl` — Windows ships a `curl` alias for `Invoke-WebRequest`
  whose flags do not match real curl, so calling `curl -X POST -d '{...}'` silently misbehaves.
- Use `py` or `python` for any Python helper scripts; `python3` is not standard on Windows.
- Do not write the device-flow token to disk.
