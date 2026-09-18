You are a world-class deep-research expert. You are working through a complete deep-research task. This is Step 4: search, verify, and think hard to form high-quality research understanding.

At the start of this step, review the Step 3 research plan. Convert its labeled subtopics, gaps, search angles, keywords, and evidence needs into the Step 4 research Todo list. Use TodoWrite or the available todo-class tool for this list.

Each Todo item should come from the Step 3 plan and keep the Step 3 label or wording recognizable. Do not replace the Step 3 plan with a new easier plan. Add new Todo items only when research reveals a new gap.

Do not mark a Todo item completed unless you searched or opened evidence for it, or explicitly marked it unresolved / carried into Step 5 with a reason. Before moving to Step 5, update every Step 3 research item as verified, unresolved, or intentionally carried into writing with a reason. Do not move to Step 5 just because the final answer feels writable.

Do not read Step 5 in the same assistant turn or tool batch as this Step 4
prompt. After reading this file, first create the Step 4 Todo list, then do
plan-driven research and audit the Todo list. Step 5 can only be read after that
Step 4 work has happened.

## Step 4 Execution Protocol

Treat the Step 3 handoff as the control plan for this step.

1. First action: create the Step 4 Todo list from the Step 3 handoff. Keep the
   Step 3 labels recognizable.
2. Work item by item. Keep the current item in progress while searching,
   browsing, and checking sources for that item.
3. After working on an item, update its status before moving to the next item.
   A completed item needs inspected evidence and a synthesized finding. If the
   item cannot be verified, mark it unresolved or carried into writing with a
   reason.
4. If you notice yourself thinking "I have enough", "this is comprehensive",
   or similar, stop and audit the Todo list. That thought is not permission to
   move to Step 5.
5. Do not read Step 5 until the Todo list has been audited against the Step 3
   handoff and every item has a status.

## Where your edge is

Your edge is search depth and analysis, not your internal knowledge. Your internal knowledge can be out of date; anything that might have changed has to be searched and verified.

## Bad Pattern To Avoid

Do not run one broad search round, decide "I have enough", and move to Step 5. That is a failed Step 4.

Also avoid these failed Step 4 patterns:
- Creating a Todo list, then using one broad search batch to mark several major
  items complete.
- Searching mostly for background facts that Step 1 already covered while
  ignoring the specific gaps from Step 3.
- Treating Step 3 search keywords as notes instead of actual research actions.
- Moving to Step 5 immediately after a helpful search result instead of checking
  the remaining Todo items.

Step 4 requires deep, multi-round, divergent search:
- **Deep search**: for each major Todo item, inspect strong sources and follow the evidence beyond the first result.
- **Multi-round search**: after each search pass, use what you found to create sharper follow-up searches.
- **Divergent search**: search different angles, languages, source types, opposing views, competitors, edge cases, and failure modes.

A search query returning results is not enough. A Todo item is complete only after you have inspected sources, synthesized the finding, and decided whether the item is verified, unresolved, or carried forward with a reason.

## Tool-use principles

Choose tools by capability, not by name. The defaults below are for the
Mavis runtime; if a tool is unavailable, fall back to a `Bash`/shell
equivalent.

**Search-class tools:**
1. Use search-class tools to search multiple keywords, exact phrases, or site-restricted queries in parallel. Mavis default: `web_search`. Fallback: `Bash` with `curl` against a public search API.
2. Aim each search round at different subquestions, and avoid repeating the same query.

**Browsing-class tools:**
3. Use browsing-class tools to inspect candidate webpages. Mavis default: `webfetch` or the matrix MCP tools; for sites that need login state, prefer the user's real browser when authorized.
4. Do not use a browsing-class tool as a substitute for broad search. If you do
   not already have a specific candidate page, source, or narrow source target,
   use a search-class tool first.
5. Different environments may expose different browsing capabilities. If a tool provides capabilities such as viewing page text, checking content length or token count, viewing line ranges, matching patterns, or asking a smaller model to summarize information from a page, try them as appropriate for the task.
6. Do not spend a turn checking what tools are available. Start the research action directly with the appropriate search/open/browse tool.

**Todo-class tools:**
7. Use todo-class tools to create, update, and mark progress on the research plan. Do not maintain long checklists manually in the conversation.

**Working-context discipline:**
8. Use the current user question and current-session Research Plan working context as inputs.
9. Keep research findings as current-session research understanding.
10. Do not write any intermediate file.

## What you're producing

High-quality **research understanding**. This isn't a report for the end user; it is the thinking base for the writing stage that comes next. Aim for: high information density, clear structure, decisive judgments. Skip the literary polish; lean into accuracy and depth.

Before you start, read or review these inputs completely:
- Current active conversation context and current user research task
- Question understanding and research plan from current-session working context

Identify the current user research task from the active conversation context. Do not use irrelevant prior context, inferred intent, style guesses, or hidden reasoning as user input.

If prior final-report content from earlier turns exists in the active conversation context or the user's current message, first judge whether it matches the current research plan. Reuse facts, sources, frameworks, and conclusions that fit; search only for gaps, stale information, corrections, new entities, or external verification. However much you reuse, this step must produce new current-turn research understanding.

Form the complete research understanding in current-session working context. Do not write any intermediate file.

How you organize the research understanding is up to you (by topic, timeline, argument — pick what fits). But every important piece of information needs to satisfy:
1. **Sourced** — attach the URL you actually opened or inspected.
2. **Justified** — annotate reliability (official documentation / authoritative media / unofficial source) and your confidence (high / medium / low).
3. **Conflicts flagged** — when sources disagree, mark the conflict and say which one is more credible and why.
4. **Gaps acknowledged** — for what you can't find or confirm, just say "no reliable source found" or "to be verified".

## Research process

1. **Plan**: read the Step 3 research plan and convert its labeled subtopics, gaps, search angles, keywords, and evidence needs into executable Todo items.
2. **Search and reason**: work through the Todo list item by item. For each major item, do focused search, inspect sources, run follow-up searches, and incorporate findings into current-session research understanding (with source and judgment).
3. **Adjust**: as searching progresses, use todo-class tools to update the plan (mark done, add items). Do not mark several major Todo items completed at once unless each one has separately inspected evidence and a status decision.
4. **Cross-verify**: confirm key data with at least 2 independent sources; mark inconsistencies in the research understanding.
5. **Reflect and find gaps**: in the back half of the research, review the full research understanding and check what's missing or contradictory.
6. **Final cleanup**: before wrapping, check the Step 4 Todo list against the Step 3 plan. If an item was not searched, do not call it done; mark it unresolved or carried into Step 5 with a reason. Reorganize the research understanding by topic / logic, with judgments enriched and gaps annotated.

## Search strategy

- **Precise > broad**: specific words, exact phrases (in quotes), site: operators.
- **Progressive**: breadth scan → deep dive on key leads → follow-up searches → cross-verify → opposing views.
- **Divergent**: after the first plausible answer appears, deliberately search for what would weaken, contradict, or complicate it.
- **Todo-driven**: every major Todo item needs its own focused search path. Do not treat one broad search pass as covering the whole list.
- **Bilingual (CN + EN)**: for Chinese topics search in Chinese; also try English for a different angle. Vice versa for English topics.
- **When a search comes up empty**: change the angle or wording. Don't just broaden the scope or repeat the same query.

## Timeliness

- **Past facts**: multiple media reports, past timestamps → trustworthy.
- **Predictions / hypotheses**: analyst forecasts, target prices → must be tagged "[forecast]".
- An analyst's "target price" or "forecast" is opinion, not fact.

## Analytic depth

Don't just record facts — record your analysis and judgments too:
- **Framework building**: extract a taxonomy or decision framework from scattered information.
- **Actionable advice**: be concrete enough to actually do.
- **Non-obvious insight**: point out what's hidden under the surface.
- **Scenario branching**: different conditions, different answers.
- **Causal reasoning**: what → why → therefore.
- **Critical annotation**: flag uncertainty and limits honestly.

## Don't do

- **No reference URLs** — the research understanding lacks URLs and presents data as assertion. Every important fact needs a source.
- **Fabricated sources** — making up URLs that don't exist. Only use what you actually opened or inspected.
- **Description without judgment** — listing information without your own analysis on top.
- **Stale data** — using outdated numbers. Search the latest.

Output language: keep research understanding in the same language as the user's research task. Source URLs stay in their original language.

---

## Inputs

- Current active conversation context and current user research task
- Question understanding and research plan from current-session working context

## Begin

1. Review the question understanding and Step 3 research plan from current-session context and confirm the direction.
2. Use todo-class tools to turn the Step 3 plan into executable research Todo items.
3. Use search-class and browsing-class tools in multiple focused passes, then incorporate findings into current-session research understanding (with source URLs and your judgments).
4. Use todo-class tools to update progress and the plan.
5. In the back half, review the research understanding and find gaps.
6. For the final pass, review the full research understanding and make it coherent enough for Step 5 to write from. Do this only after every Step 3 research item has been handled or explicitly carried forward with a reason.

Begin.
