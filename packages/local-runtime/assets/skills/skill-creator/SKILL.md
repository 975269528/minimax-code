---
name: skill-creator
description: |
  Create a new Mavis skill with a short eval-driven loop. Use when the user asks to
  create a skill, turn a repeated workflow into a skill, or build a new reusable procedure.
  Do not use for improving or fixing an existing skill (use skill-refiner instead),
  or when the user only wants to run a skill or learn what skills exist.
descriptions:
  zh-Hans: "创建新的 Mavis skill，用短 eval 循环把重复工作流沉淀为可复用流程。"
displayNames:
  zh-Hans: "创建 Skill"
---

# Skill Creator

Turn a reusable workflow into a dense skill, then verify it against a real prompt.

## Inputs to collect

Collect only the missing information:

1. **Goal**: What should the skill help the model do?
2. **Triggers**: What user phrases should activate it?
3. **Boundaries**: What nearby requests should not trigger it?
4. **Success bar**: What does one good run look like?

If the user only has a vague idea, clarify the request before continuing. Do not invent a long interview flow inside this skill.

## Mandatory platform command router

This skill intentionally keeps executable shell recipes OUT of `SKILL.md`. Before you run any command for this skill, select exactly one platform command reference and use only that file's recipes.

Router:

1. Read `<agent-context>.platform`.
2. If `platform` is `win32`:
   - REQUIRED: read `references/commands-windows-powershell.md`.
   - Use PowerShell recipes from that file only.
   - Do NOT use bash snippets, `/tmp/...`, `mkdir -p`, `cat <<EOF`, or `python3` assumptions.
3. If `platform` is `darwin` or `linux`:
   - REQUIRED: read `references/commands-macos-linux.md`.
   - Use bash/zsh recipes from that file only.
4. If `platform` is missing or unknown:
   - Do a tiny preflight to identify the shell/platform before running anything.
   - If still unclear, ask the user which environment is running the command.

Never translate shell commands across platforms from memory. The platform reference files own every recipe this skill needs (`run-lint`, `eval-scratch-dir`, `baseline-output-paths`).

## Procedure

1. Check whether a matching skill already exists.

Check the `<available_skills>` block already in your context — it lists every skill's name and description. Call `skill({ name: "<name>" })` to read a candidate in full.

If a nearby skill already covers the use case, **do not create a duplicate**. Instead, tell
the user to use `skill-refiner` to extend or improve the existing skill.

2. Determine the skill scope.

Use the three-question test to decide where the skill lives:

- **Will the answer change for a different user?** → User skill (`{{DATA_DIR}}/skills/`)
- **Does it hold true across projects?** → Agent skill (`{{DATA_DIR}}/agents/<name>/skills/`)
- **Only relevant to the current project?** → Project skill (`<repo>/.minimax/skills/` — the native workspace skill root; existing workspace skill roots also work)

3. Capture the reusable workflow from the lightest source available.

- Prefer the just-finished conversation or user-provided workflow doc.
- Condense it into the minimum procedure another model needs.
- If the idea is still vague, clarify it with the user, then return here.

4. Design the skill around progressive disclosure.

- Put trigger/boundary information in frontmatter `description`, not in a `When to use` section.
- Keep `SKILL.md` focused on execution rules: procedure, output contract, failure handling.
- Move bulky background, schemas, or variants into `references/`.
- Add `scripts/` only for deterministic local work.

5. Draft `SKILL.md` with high information density.

- Keep body sections short and imperative.
- Remove README-style teaching, feature tours, redundant trigger lists, and API-overview prose.
- Keep only one or two canonical examples.
- Follow `references/skill-template.md`, `references/description-rubric.md`, and `references/anti-patterns.md`.
- **Windows adaptation**: if the skill contains shell commands, scripts, or `python3` references, add a `## Windows (win32) platform notes` section with PowerShell equivalents or cross-platform alternatives. Pure-process skills (no shell commands) can skip this.

Write the skill into the location determined in step 2:

```
{{DATA_DIR}}/skills/<skill-name>/
{{DATA_DIR}}/agents/<agent-name>/skills/<skill-name>/
<repo>/.minimax/skills/<skill-name>/
```

Use this structure only when needed:

```
<skill-root>/
├── SKILL.md
├── scripts/        # deterministic local work only
└── references/     # bulk material the main file should not inline
```

Do not create extra scaffolding by default: `README.md`, `CHANGELOG.md`, `install.sh`, `.env`, `.env.example`, `.gitignore`, `assets/`, or `evals/`.

For script bundling rules, see `references/when-to-bundle-scripts.md`.

6. Lint before eval.

First locate the skill-creator install directory: call `skill({ name: "skill-creator" })` and take the directory of the returned `Location:` path. Then use the `run-lint` recipe from the selected platform command reference to run `node scripts/lint-skill.js` against the new skill path.

Check for complete frontmatter, matching kebab-case names, a useful description, main-file size,
forbidden files, and valid `references/` links.

Do not move on until lint passes.

7. Eval against a real user prompt.

Eval compares "with-skill" vs "without-skill" on a real prompt.

**Pick a real eval prompt first**: a genuine user question that should trigger this skill.

Launch two Task tool calls (subagents) with `run_in_background: true` so they run in
parallel — foreground task calls execute sequentially. Use the
`baseline-output-paths` recipe from the platform command reference for the writable
scratch directory (do NOT hardcode `/tmp/`):

1. **Producer**: "Load skill at `<SKILL_PATH>`, use it to handle: `<EVAL_PROMPT>`.
   Write your process and output to `<scratch>/eval-<skill-name>/with-skill.md`."
2. **Baseline**: "Handle this task without loading any skill: `<EVAL_PROMPT>`.
   Write your process and output to `<scratch>/eval-<skill-name>/baseline.md`."

Both eval tasks write process and output files under the scratch directory, so each Desktop
Task call must use `agent_name: worker`. A background launch returns a task id immediately,
not the result — poll with `task_query` until both tasks reach a terminal state and collect
each result with `task_output`. Only then read the two files and write the comparison verdict
yourself, covering all 5 points:

1. **Is with-skill actually better?** — explicit verdict: yes / no / mixed.
2. **If better, where?** — concrete to a procedure step or output-contract difference.
3. **If not better or worse, why?** — did the skill add unnecessary steps, overfit to a fixed
   format, or constrain the model's judgment?
4. **Improvement suggestions** — 3-5 concrete changes to `SKILL.md` or `references/`.
5. **Should a script be bundled?** — check the producer's process for a repeated deterministic
   action; also sanity-check token use (with-skill should not burn 2x baseline tokens without a
   quality gain).

8. Iterate only if eval exposes a real weakness.

Read the comparison output, improve the skill, then repeat lint and eval.

Stop when any of these is true:
- the user is satisfied
- the skill clearly beats or matches baseline without major regressions
- two rounds in a row produce no meaningful gain

## Output contract

Deliver:
- a skill under the appropriate scope directory (user / agent / project)
- a passing lint result
- at least one evaluation round where the skill is not worse than baseline

## Failure handling

- If lint keeps failing, rewrite the skill more simply instead of padding it.
- If eval says the skill is worse than baseline, check whether the problem is description quality, body bloat, over-strict procedure, or whether the skill should exist at all.
- If the user cancels the idea, remove the unfinished skill directory instead of keeping a half-product.

## Examples

**Input**: "I just figured out how to check someone's availability in Feishu Calendar. Turn this into a skill."

**Good path**:
1. Check `<available_skills>` in context and find no existing availability-checking skill.
2. Ask the scope question: this is user-agnostic and cross-project, so agent skill.
3. Draft a concise `SKILL.md` with the procedure, lint it, run eval.

**Bad path**: immediately create a brand-new skill without checking for overlap first, or try to
extend an existing calendar skill in this creator instead of directing to skill-refiner.

## Additional resources

- `references/commands-macos-linux.md` - bash/zsh recipes (darwin/linux)
- `references/commands-windows-powershell.md` - PowerShell recipes (win32)
- `references/skill-template.md` - section skeleton
- `references/description-rubric.md` - description guidance
- `references/anti-patterns.md` - common failure modes
- `references/when-to-bundle-scripts.md` - script vs subagent vs direct procedure
- `scripts/lint-skill.js` - deterministic validation
