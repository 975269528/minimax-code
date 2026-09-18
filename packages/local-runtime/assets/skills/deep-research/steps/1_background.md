You are working through a complete deep-research task. This is Step 1: confirm the factual background of the topic by searching and gathering as much factual background as possible.

Don't analyze, don't conclude, don't try to figure out how the question should be answered — just search and summarize facts you can verify directly from sources.

## Task

- Only use what you actually found in a source and what the source directly supports. No filling in, guessing, inferring, analogizing, or extrapolating.
- Don't infer the present from old information. If a source only proves something at a past date, keep the date explicit, e.g. "as of 2023-07".
- Don't use words like "currently", "now", "still", "incumbent", "ongoing", or "about to" without a direct, recent, reliable source.
- For anything you can't directly confirm, keep it marked as "no reliable source found" or "to be verified".
- If sources disagree, keep the conflict visible — don't try to settle it yourself.
- Don't pad with your internal knowledge. Searched facts only.

For a fresh topic, run 5–8 searches with different keywords and angles (try both Chinese and English; mix up search-engine operators), covering:
- The core of the topic (what it is, who's working on it, where things stand)
- Recent significant developments (timeline, key events)
- Key people, organizations, numbers, technical details
- Where the authoritative sources live (official channels, industry reports, academic papers)
- Disputes or competing viewpoints
- Related competitors or alternatives

Keep the first background searches neutral. If the question is phrased like
"What should X do?" and X is a company, product, model, or project, gather facts
about X, its owner/operator, positioning, roadmap, competition, public
reception, and constraints. Do not narrow the topic into API usage, deployment,
prompting, integration, or an end-user guide unless the user explicitly asks how
to use, deploy, or integrate X.

Step 1 is a factual-background map, not the deep investigation. Do not try to
exhaust every page, post, repository, search result, or clue in this step. Once
the main factual background, authoritative source locations, obvious disputes,
and open gaps are identified at a background level, stop Step 1 and move to
Step 2. Leave targeted deep digging, cross-checking, and gap filling to Step 4.
For a single website, repository, or person-focused target, sample the homepage,
about/profile pages, search results, and a few representative pages; do not
scrape the whole site or keep following every newly discovered clue in Step 1.
Do not create the research Todo list in Step 1, and do not decide that the task
is ready to answer from Step 1 facts alone. Step 1 should leave clear open gaps
for Step 2 direction judgment, Step 3 planning, and Step 4 plan-driven research.

Use search-class tools for discovery. In the Mavis runtime, use `web_search`
for search when available. Use browsing/opening tools such as `web_fetch`,
`WebFetch`, or the matrix MCP tools only to inspect specific candidate pages or
sources found through search; do not use a browsing-class tool as the first
broad search for a long natural-language query. Do not spend a turn checking
what tools are available; start searching directly.

The goal is to give the next analysis stage a thick factual base to work from. Don't judge or analyze — just collect facts.

When forming the Step 1 background understanding:
- Keep the structure easy to scan; Markdown-style organization is fine.
- Keep real source URLs attached whenever you can.
- Keep it factual; do not answer the question itself.
- Think through the material in terms of "historical facts" / "current state (only what's directly verifiable)" / "to be verified".
- Keep the complete background understanding in the current session so the next step can use it.

Use the same language as the user's query. English query → English; another language → that language. Source URLs stay in their original language.

---

Before you start, identify the current user question from the active conversation context. Do not use irrelevant prior context, inferred intent, style guesses, or hidden reasoning as user input.

If the active conversation context or the user's current message includes prior final-report content, use it only when it is relevant to the current turn. Prefer the immediately previous completed turn; for many turns, such as turn 20, start from turn 19 and use older turns only when the current query explicitly depends on them.

Facts only. Don't analyze the question itself.
