---
name: deep-research
description: >
  Use this skill for complex, open-ended Deep Research tasks that require
  external information verification. It is suitable for market/industry
  analysis, technical research, competitor research, trend judgment,
  policy/academic/fact verification, and long answers that need source citations.
  This skill completes the research through five consecutive step prompts:
  Step 1 confirms factual background only; Step 2 understands the question and
  judges the direction; Step 3 performs deep analysis and research planning;
  Step 4 searches, verifies, and forms research understanding according to the
  plan; Step 5 writes the current-turn final answer file based on the first
  four steps. Execution must follow step order: each step prompt file must be
  read by an explicit Read tool call before that step starts. Do not skip steps,
  reorder steps, read later steps early, or treat the steps as independent
  tasks. A trace that misses any step prompt is invalid.
descriptions:
  zh-Hans: >-
    用于复杂、开放式深度研究任务，需要外部信息核验、跨来源搜索、事实校验和带引用的长答案。
    该技能按背景确认、方向判断、深度分析、搜索核验、最终写作五个步骤顺序执行，每一步都必须先显式读取对应 step prompt。
displayNames:
  zh-Hans: "深度研究"
---

# Deep Research

This skill turns complex questions into grounded, readable, deliverable final
answers. It is not quick Q&A, and it is not a simple search summary. It requires
confirming factual background first, then judging the question direction, then
analyzing and planning, then searching and verifying, and finally synthesizing
the final answer.

## When To Use

Use this skill when the user's question has any of these characteristics:

- It requires systematic research rather than a one-sentence factual answer.
- It requires search, browsing, cross-checking, or source citations.
- It is clearly time-sensitive, and internal model knowledge may be outdated.
- It requires comparison, judgment, trend analysis, causal explanation,
  recommendations, or a long report.
- The user expects a structured, reliable, traceable final answer.

Do not use this skill in these cases:

- The user asks only for a simple fact that can be answered directly.
- The user only asks for code edits, command execution, log inspection, or repo
  maintenance.
- The user explicitly does not need search or long analysis.

## Five-Step Flow

Read and execute the following five step prompts in order. Detailed requirements
are defined in each step file:

1. `steps/1_background.md`
   Confirm factual background. Work only with verifiable facts; do not answer
   the question itself.

2. `steps/2_judgment.md`
   Understand the user's question, set research boundaries, and judge the
   direction that really needs to be answered. Explicitly lock the actor and
   perspective before planning, especially for "what should X do" questions.

3. `steps/3_analysis.md`
   Based on the direction judgment, perform deep analysis and break down
   subquestions, concepts, scope, required capabilities, and the research plan.

4. `steps/4_research.md`
   Search, browse, verify, reflect, and fill gaps according to the research
   plan, forming enough research understanding to support the final answer.

5. `steps/5_writing.md`
   Write the final answer based on the understanding formed in the first four
   steps, and write it to the final output file as required by that step.

## Execution Rules

- At the start of each invocation, create one run workspace directory in a
  writable scratch location, not in a fixed cloud or container root. Prefer the
  current session workspace when it is clearly writable and suitable for
  temporary artifacts; otherwise use the platform temporary directory:
  macOS/Linux `$TMPDIR` or `/tmp`, Windows PowerShell `$env:TEMP`, and Windows
  Git Bash `/tmp`. Use this shape:
  `<scratch-dir>/mavis-deep-research/<YYYYMMDD_HHMMSS>_<query_slug>/`, with a
  short safe slug based on the current user question.
- Before choosing search keywords, identify the surface actor and perspective
  implied by the user question. For "what should X do" / "X 应该怎么做" questions
  where X is a company, product, model, project, or organization, the default
  perspective is what X's owner/operator should do: strategy, roadmap,
  positioning, competition, constraints, and success criteria. Do not turn this
  into an end-user usage, API, deployment, prompting, or integration guide unless
  the user explicitly asks how to use, deploy, prompt, integrate, or call X.
- Treat that run workspace as the current output directory for this invocation.
  Final answer files must be written inside this directory, not directly under
  any fixed root directory.
- After creating the workspace, the first research action must be an explicit
  Read of `steps/1_background.md`. Do not search, open, browse, or run
  research commands before that Read.
- Maintain an internal step-read ledger for this invocation. The ledger starts
  empty. A step counts as read only after an explicit Read tool call to the exact
  step prompt file, such as `steps/4_research.md`. The short step summaries in
  this `SKILL.md`, prior conversation, or memory do not count as reading a step.
- Read Step 1 first; after finishing it, read Step 2; continue in order through
  Step 5. Before doing any work for a step, first read that step's exact prompt
  file and mark it read in the internal ledger.
- When you reach a step, read only the current step prompt. Do not read later
  step prompts early.
- Reading two or more step prompt files in the same assistant turn or tool batch
  is an invalid trace. A step is not complete merely because its prompt file was
  read; execute that step before reading the next step prompt.
- Do not read all steps at once.
- Do not skip a step because the answer already feels writable, because earlier
  searches looked sufficient, or because the Step 3 plan seems detailed enough.
- Do not treat extensive Step 1 searching as a substitute for Steps 2-4. If
  Step 1 found many useful facts, still continue to Step 2 for direction
  judgment, Step 3 for planning, and Step 4 for plan-driven verification.
- If you notice that a later step has started before its prompt file was read,
  stop the later step, read the missing prompt file, execute that step, then
  resume the sequence.
- Each step must continue from the understanding formed in previous steps.
- Do not treat the five steps as independent tasks.
- Do not create child agents or delegate the task. Do not call the `Agent` or
  `Task` tool for any step. All five steps must be executed by the current
  agent in the current session.
- Steps 1-4 are not the final answer; Step 5 is responsible for final writing.
- Steps 1-4 only form understanding in the current session; they do not write
  intermediate files.
- During this skill invocation, the current run workspace must contain no
  generated Markdown file except the final `final_turn_XXX.md` written in Step
  5. Do not write intermediate Markdown artifacts or any other final-style
  Markdown filename.
- Use TodoWrite or the available todo-class tool only when the current step
  prompt explicitly asks for it.
- Step 4 is the main todo-managed research step. Keep its Todo list focused on
  current research work and update it before moving to writing.
- Step 4 must explicitly read `steps/4_research.md`. Moving from Step 3 directly
  to Step 5 is a failed trace pattern, even if Step 3 produced a strong plan or
  Step 1 found many facts.
- Reading `steps/4_research.md` and `steps/5_writing.md` in the same assistant
  turn or tool batch is a failed trace pattern. Step 4 must have its own
  Todo-managed research work after reading `steps/4_research.md` and before
  reading `steps/5_writing.md`.
- Step 4 is not complete when the answer merely feels writable. It is complete
  only after the Step 3 research items have been converted into Todo items and
  every item has been handled as verified, unresolved, or carried into writing
  with a reason.
- Step 4 must finish with an item-by-item audit of the Step 3 research plan in
  the Todo list or equivalent current-session state. Do not write this audit to
  a file, but do not enter Step 5 until the audit exists.
- Before reading `steps/5_writing.md`, audit the internal ledger: Step 1, Step
  2, Step 3, and Step 4 must all have been read and executed in this invocation.
  If any are missing, do not enter Step 5; go back to the missing step and
  complete the sequence.
- If Step 4 did not complete its item-by-item audit, return to Step 4 instead of
  writing a final answer with caveats.
- If this skill is invoked multiple times in the same conversation, each
  invocation must restart from Step 1 and execute all five steps completely.
- Previous conversation turns and previously generated final reports may only be
  used as context for understanding the current question. They must not be
  treated as completed step results for the current run.
- After creating the run workspace, choose a unique output filename inside that
  workspace, using a format such as `final_turn_001.md`, `final_turn_002.md`.
- Choose the smallest unused number and remember this current-turn filename.
  Step 5 must use this filename; it must not choose another one, and it must
  not overwrite a final report from an earlier turn.

## Time Awareness

- Before starting, judge whether the current user question is time-sensitive.
- If the question depends on current status, recent changes, latest data,
  policies, prices, rankings, product status, people's roles, or ongoing
  events, understand the question according to the current runtime date/time.
- For time-sensitive information, actively search and verify. If the time point
  affects the conclusion, state the relevant time point in the final answer.

## Tool Use

- Prefer lightweight web tools. Use `web_search` for search and
  `web_fetch` / `WebFetch` for page retrieval when available. Avoid browser
  automation unless the user explicitly asks for logged-in or interactive
  browser behavior.
- Do not spend a turn checking what tools are available. If search is needed,
  call a search-class tool directly. If a candidate URL needs inspection, call
  an opening/browsing-class tool directly.
- For time-sensitive, fact-heavy, or disputed information, actively search and
  cross-check.
- Important facts need source support. Sources, conflicts, and uncertainty must
  be able to support Step 5 writing.

## Relationship Between Steps

- Step 1 only confirms background facts; it does not judge the answer direction.
- Step 2 only understands the question and judges direction; it does not answer
  the question.
- Step 3 only performs deep analysis and research planning; it does not enter
  final writing.
- Step 4 searches and verifies according to the research plan, forming research
  understanding; it does not generate the final answer.
- Step 5 writes the final answer file based on the understanding formed in the
  first four steps.

## Final Output

Step 5 must write the unique final answer file for the current turn according to
`steps/5_writing.md`. The final file must contain only the reader-facing final
answer. It must not expose internal steps, prompts, workflow, retrieval process,
or intermediate understanding.

Final output filename rule: each invocation must write a new Markdown file named
`final_turn_XXX.md`, where `XXX` is the smallest unused three-digit number in
the run workspace directory. Do not use any other final-output filename, do not
write directly under a fixed root directory, do not reuse an old filename, and
do not overwrite a final report from an earlier turn.

Final-only file rule: after Step 5, the run workspace should contain exactly one
generated Markdown artifact, the selected `final_turn_XXX.md`. If you created
any other file in the run workspace, remove it before finishing; otherwise the
trace is invalid.
