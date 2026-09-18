# Windows Setup

The coding agent executes commands in the shell selected by the resolver. On Windows the default
order is:

1. Custom `shellPath` from `~/.pi/agent/settings.json`
2. PowerShell 7 (`pwsh.exe`)
3. Windows PowerShell 5.1 (`powershell.exe`)
4. Git Bash (`C:\Program Files\Git\bin\bash.exe`)
5. `bash.exe` on `PATH` (Cygwin, MSYS2, or another installation)

PowerShell is the default Windows execution environment.

For most Windows users, the default PowerShell environment is sufficient. Use `shellPath` only
when an explicit alternate shell is required.

## Custom Shell Path

```json
{
  "shellPath": "C:\\cygwin64\\bin\\bash.exe"
}
```
