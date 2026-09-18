---
name: skill-refiner
description: |
  Refine an existing Mavis skill with evidence-driven minimal patches.
  Use when a skill has a concrete problem (wrong instructions, outdated steps,
  missing edge case) backed by evidence. Do not use for creating new skills
  (use skill-creator), or for stylistic preferences without evidence.
descriptions:
  zh-Hans: '基于证据对已有 Mavis skill 做最小修补，修正错误说明、过期步骤或缺失边界。'
---

# Skill Refiner

Apply the smallest evidence-backed patch to fix a real skill problem.

## When NOT to use

- Creating a brand-new skill -> use `skill-creator`
- No concrete evidence of a problem -> do nothing
- The agent failed to follow correct instructions -> agent error, not a skill issue

## Procedure

1. **Collect evidence**.

Identify exactly what went wrong. Evidence sources:

- User feedback in the current session ("this skill told me to X but the right step is Y")
- A concrete failure trace where the skill's instructions caused wrong behavior

If the only evidence is "the skill could be better" with no specifics, stop here.

2. **Read the current skill**.

```
skill({ name: "<name>" })
```

The native `skill` tool returns the SKILL.md body plus a `Location:` header with the file path. Capture the current content before editing.

3. **Attribute the problem**.

Before touching the skill, determine what actually went wrong:

| Situation                                               | Action                                  |
| ------------------------------------------------------- | --------------------------------------- |
| Skill text is factually wrong or outdated               | Fix the skill                           |
| Agent didn't follow the skill's correct instructions    | Do NOT change the skill -- agent error  |
| Environment changed (new API, renamed command, etc.)    | Update the skill to reflect new reality |
| Skill works for the common case but misses an edge case | Add the edge case                       |
| Stylistic preference with no functional impact          | Do NOT change                           |

If the problem is not in the skill itself, explain why and stop.

4. **Generate patch**.

Design the minimal change that fixes the problem. Document:

```
Problem:   <what is broken>
Evidence:  <specific quote, error trace, or user statement>
Rationale: <why this change fixes it without breaking other behavior>
```

Use `old_string` / `new_string` format for each edit point. Prefer surgical patches over section
rewrites.

5. **Self-check before applying**.

Ask yourself:

- Does this change actually address the evidence? (not a nearby symptom)
- Could it break existing correct behavior?
- Am I adding generic best practices instead of fixing a specific problem? (anti-pattern)
- Is this a self-referential modification? (skill-refiner editing itself -- forbidden)

If any check fails, revise the patch or abandon the change.

6. **Apply the patch**.

Two routes depending on skill type:

#### User / Agent skills (mutable)

Edit the skill file directly with the Edit tool (user skills live in
`{{DATA_DIR}}/skills/<name>/`, agent skills in `{{DATA_DIR}}/agents/<agent>/skills/<name>/`).
Re-read the file right before editing so you are patching the current content,
not a stale copy.

#### Built-in / Project skills (immutable at runtime)

These live in the repo (`packages/local-runtime/assets/skills/` or the project's own skill
directory under version control). Do NOT edit the runtime copies. Instead:

1. Note the required change
2. Advise the user to make the change in a worktree and submit via MR

4. **Verify**.

After applying, re-read the skill and confirm:

- The patch landed correctly
- The frontmatter `name` and `description` are intact
- The overall skill still reads coherently

```
skill({ name: "<name>" })
```

## Hard constraints

- **No secrets**: never write API keys, tokens, or credentials into skill files
- **Size limit**: skill must stay under 100KB after patch
- **Frontmatter sacred**: `name` and `description` fields must survive every edit
- **No self-referential edits**: skill-refiner must not modify its own SKILL.md
- **Evidence mandatory**: every patch must trace back to a specific problem
- **Built-in skills are read-only**: changes go through MR, not runtime edits

## Anti-patterns

- Rewriting a skill from scratch when a one-line fix would work
- Adding generic disclaimers ("always check...", "be careful to...")
- Deleting a correct instruction because one report was a false positive
- Changing style (wording, formatting) without functional justification
- Applying multiple unrelated fixes in one patch (split them)
- Acting on a report without verifying the evidence first

## Output contract

Deliver:

- The applied patch with problem/evidence/rationale documented
- Verification that the skill reads correctly post-patch

## Failure handling

- If the file changed under you (concurrent edit), re-read and re-plan the patch
- If the patch makes the skill worse on re-read, revert and try a different approach
- If evidence is ambiguous, explain why and stop rather than guessing
