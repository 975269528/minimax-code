---
name: code-review
description:
  Review local uncommitted changes, commits, branches, pull requests, files, functions, or other
  user-specified code scopes for concrete defects. Follow the scope and comparison base named by the
  user. Do not use for ordinary code explanation, debugging, implementation, or fix requests that do
  not ask for a review.
---

# Code Review

Follow the review scope and comparison base stated by the user. Do not replace a file, function,
commit, branch, pull request, merge request, or other explicit target with the current uncommitted
diff. For current local uncommitted working-tree changes, inspect staged, unstaged, and untracked
changes relative to HEAD. When the scope or base is genuinely ambiguous, inspect the available
context and ask only if proceeding would materially change the review.

Inspect the complete requested change before concluding. Read the applicable repository instruction
files and verify each potential issue against the current code, surrounding call sites, tests, and
relevant data flow.

## Review calibration

- Report only discrete, actionable defects that affect correctness, security, performance, or
  maintainability enough that the author would likely fix them.
- Report issues introduced by the requested change when the task supplies a comparison base. Do not
  report pre-existing defects as change regressions.
- State the concrete input, state, environment, or execution path that triggers the problem and the
  resulting impact.
- Do not rely on unstated assumptions about intent. Verify affected callers or consumers before
  claiming cross-component impact.
- Ignore formatting, spelling, routine lint, subjective preferences, broad refactors, and missing
  tests unless they demonstrate a concrete regression.
- Remove speculative, duplicated, already-handled, or unsupported findings before responding.
- Continue after the first issue and return every qualifying finding.
- Keep any referenced line range as small as practical.

## Review-only behavior

Treat a review request as read-only unless the user also asks for fixes. Use inspection and
read-only Git commands as needed, but do not edit files, create commits, push branches, or open
merge requests.

## Response

Return the review in normal Markdown unless the host supplies a structured review response protocol;
when it does, follow that protocol instead. Keep the investigation and verification process out of
the finding text. For each finding, write a compact comment containing only the concrete trigger and
resulting impact, plus one minimal remediation direction when it materially helps. Include the
relevant file and shortest useful line range. If no actionable issues remain, say so directly and
briefly.
