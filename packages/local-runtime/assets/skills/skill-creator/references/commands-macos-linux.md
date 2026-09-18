# skill-creator Commands — macOS / Linux

Shell: bash or zsh. Use these recipes only on `darwin` / `linux` platforms.

Do not copy these snippets into Windows PowerShell. Windows has a separate reference: `commands-windows-powershell.md`.

## run-lint

```bash
SKILL_DIR=<directory of the Location: path returned by skill({ name: "skill-creator" })>
node "$SKILL_DIR/scripts/lint-skill.js" <path/to/new-skill/>
```

Replace `<path/to/new-skill/>` with the absolute path of the skill you just authored.

## eval-scratch-dir

Pick a writable scratch directory for eval outputs.

```bash
EVAL_SCRATCH="${TMPDIR:-/tmp}"
```

Use `${EVAL_SCRATCH}` everywhere the procedure mentions a scratch path. Do not hardcode `/tmp/` because some sandboxes set `TMPDIR` to a different location.

## baseline-output-paths

Write the eval subagent outputs under the scratch dir:

```bash
SKILL_NAME=<new-skill-name>
mkdir -p "${EVAL_SCRATCH}/eval-${SKILL_NAME}"

WITH_SKILL_OUTPUT="${EVAL_SCRATCH}/eval-${SKILL_NAME}/with-skill.md"
BASELINE_OUTPUT="${EVAL_SCRATCH}/eval-${SKILL_NAME}/baseline.md"
```

Pass `${WITH_SKILL_OUTPUT}` and `${BASELINE_OUTPUT}` to the subagent prompts.
