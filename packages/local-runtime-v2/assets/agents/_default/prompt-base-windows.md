## Windows Shell Constraints

### PowerShell only

- Use **PowerShell syntax only**. Do NOT use legacy DOS / `cmd.exe` commands (`cmd`, `cmd /c`,
  `dir`, `type`, `copy`, `move`, `del`, `erase`, `rd`, `rmdir`, etc.). Use full PowerShell
  cmdlets instead (`Get-ChildItem`, `Copy-Item`, `Move-Item`, `New-Item`).
- The bash tool already runs the command through the selected Windows shell. Do not wrap ordinary
  bash-tool commands in `powershell -Command`. If you truly must launch a nested `pwsh`/PowerShell
  process, prefer `pwsh -NoProfile -NonInteractive -Command '<script>'` and keep the outer
  `-Command` payload single-quoted so `$variables` are not expanded by the parent PowerShell.
- For deletion, do not use shell delete commands; use the Trash tool or move files to a backup
  location.
- For multi-statement PowerShell scripts, start with `$ErrorActionPreference = 'Stop'`. When the
  script runs native programs and must fail on non-zero exit codes, set
  `$PSNativeCommandUseErrorActionPreference = $true` when available, or check `$LASTEXITCODE`
  explicitly after the native command.
- Do NOT use Bash-style `\"` to escape double quotes inside PowerShell strings. Use PowerShell
  quoting rules: single quotes for literal text, doubled single quotes inside single-quoted strings,
  double quotes only when interpolation is intended, and the backtick only for PowerShell escapes.
- Wrap regex/search patterns in single quotes, especially for `rg` / `Select-String` patterns
  containing `|`, `(`, `)`, `\`, `$`, or other PowerShell metacharacters. Prefer the dedicated
  grep tool for repository searches; when shell search is necessary, keep the command simple and
  split complex pipelines into separate tool calls.

### File content operations — encoding safety

- **Prefer the Read / Write / Edit tools for focused file reads and edits** — they operate directly
  in UTF-8 and bypass shell encoding issues entirely. This is the default approach for ordinary
  file content work; use the batch-edit exception below when dedicated tools are not efficient.
- **Do NOT use `Get-Content | … | Set-Content` pipelines to modify file contents.** Windows
  PowerShell 5.1 defaults to the system ANSI code page (e.g. GBK / CP936 on Chinese Windows).
  Without `-Encoding UTF8`, `Get-Content` silently mis-decodes UTF-8 multi-byte characters as
  ANSI, and `Set-Content` writes the corrupted data back — destroying CJK comments, strings,
  and even line structure in source files. The corruption is **silent** (no error, no warning).
- If you must use `Get-Content` or `Set-Content` in a shell command (e.g. reading a small config
  value), **always** pass `-Encoding UTF8`. Be aware that PowerShell 5.1's `-Encoding UTF8`
  adds a BOM (`EF BB BF`), which may affect some tools.
- For batch file modifications that dedicated tools cannot express efficiently, generate a
  **Python script** (with `encoding='utf-8'`) instead of a PowerShell pipeline.

### Deliverable verification

- To verify that a local deliverable exists before sending it, use
  `Test-Path -Path <path> -PathType Leaf` or read the file back.
