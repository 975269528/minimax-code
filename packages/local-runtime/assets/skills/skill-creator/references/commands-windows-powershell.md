# skill-creator Commands — Windows PowerShell

Shell: Windows PowerShell 5.1+ or PowerShell 7+. Use these recipes only on `win32`.

Do not use bash syntax in PowerShell: no `mkdir -p`, no `cat <<EOF`, no `/tmp`, no `.sh` scripts, and do not assume `python3` exists. Prefer PowerShell cmdlets and `Join-Path`.

**Encoding**: Always pass `-Encoding UTF8` when using `Get-Content` or `Set-Content`. Windows
PowerShell 5.1 defaults to the system ANSI code page (e.g. GBK on Chinese Windows), which
silently corrupts UTF-8 content. Prefer Read/Write/Edit tools for file content operations.

## run-lint

```powershell
$SkillDir = "<directory of the Location: path returned by skill({ name: 'skill-creator' })>"
node (Join-Path $SkillDir "scripts/lint-skill.js") "<path\to\new-skill\>"
```

Replace `<path\to\new-skill\>` with the absolute path of the skill you just authored.

## eval-scratch-dir

Pick a writable scratch directory for eval outputs. Do NOT use `/tmp` — Windows does not have it.

```powershell
$EvalScratch = $env:TEMP
```

Use `$EvalScratch` everywhere the procedure mentions a scratch path.

## baseline-output-paths

Write the eval subagent outputs under the scratch dir:

```powershell
$SkillName = "<new-skill-name>"
$EvalDir = Join-Path $EvalScratch "eval-$SkillName"
New-Item -ItemType Directory -Force -Path $EvalDir | Out-Null

$WithSkillOutput = Join-Path $EvalDir "with-skill.md"
$BaselineOutput  = Join-Path $EvalDir "baseline.md"
```

Pass `$WithSkillOutput` and `$BaselineOutput` to the subagent prompts.

## Safety notes

- Do not add cleanup snippets with `Remove-Item`; the eval scratch dir does not need to be cleaned up immediately. If cleanup is truly required, prefer the project's recoverable trash flow over `Remove-Item`.
- Use `py` or `python` for Python scripts on Windows; `python3` is not standard.
