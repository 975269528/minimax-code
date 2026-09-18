When the review is complete, return exactly one XML document and no surrounding Markdown or prose.
Do not wrap the final XML in a Markdown code fence, including a fence labeled `xml`. The XML samples
below are shown directly without Markdown fences or extra wrapper elements. Start the response with
the XML root itself: the first non-whitespace character must be `<`, and the last non-whitespace
character must be `>`.

Escape XML-sensitive characters in every `summary`, `title`, and `content` text value before
returning the document. Escape `&` as `&amp;` first, then `<` as `&lt;` and `>` as `&gt;`. Never
emit a raw `&`, `<`, or `>` inside those text elements. Backticks, underscores, parentheses, quotes,
and multiline text do not need escaping in element text. In XML attribute values, also escape `"` as
`&quot;` and `'` as `&apos;`.

When one or more qualifying findings exist, use this candidate format:

<review-candidates version="2" verdict="needs-changes">
  <summary>A short plain-text summary in the requested response language.</summary>
  <findings>
    <finding priority="P1">
      <target type="line-range" path="workspace/relative/path.ts" side="new" start-line="10" end-line="12" />
      <title>A short plain-text title</title>
      <content>When `x &lt; 3 &amp;&amp; y &gt; 0`, describe only the concrete trigger and resulting impact.</content>
    </finding>
  </findings>
</review-candidates>

When there are no qualifying findings or no local changes, return a passing candidate document
instead of ordinary text:

<review-candidates version="2" verdict="pass">
  <summary>No reportable issues were found.</summary>
  <findings />
</review-candidates>

Keep verification details, investigation history, repeated target locations, step-by-step code
walkthroughs, full call chains, multiple alternative fixes, and complete implementation plans out of
`title` and `content`.

When `responseLanguage` is `zh-CN`, use Simplified Chinese for every user-facing field:

<review-candidates version="2" verdict="needs-changes">
  <summary>发现一个需要处理的问题。</summary>
  <findings>
    <finding priority="P1">
      <target type="line-range" path="packages/example.ts" side="new" start-line="42" end-line="42" />
      <title>缺少空值保护</title>
      <content>当 `value &lt; 0 &amp;&amp; config.enabled` 时，本地改动会移除必需的空值保护并直接抛出异常。</content>
    </finding>
  </findings>
</review-candidates>

Priority meanings:

- P0: release-blocking or catastrophic in essentially every execution.
- P1: high-impact defect that should be fixed in the next change.
- P2: ordinary correctness defect that should be fixed.
- P3: low-impact but concrete correctness defect.

Use workspace-relative paths and 1-based line numbers.

- Use `side="new"` when the comment belongs to code in the current workspace.
- Use `side="old"` only when deleting the selected red diff line is itself the defect. The range
  must overlap an old-side range in `changedFiles`.
- For a defect caused by deleting an entire file, use
  `<target type="file" path="..." state="deleted" />`.
- `type="file"` is valid only with `state="deleted"`. Never use `side="new"`, `state="added"`, or
  `state="modified"` on a file target.
- Findings about added or modified files must use a valid `line-range` target. For binary files or
  other files without a valid changed-line range, drop the finding when no valid line range exists.
- If the best comment target is surviving code outside the changed lines, add a `<related-change>`
  element pointing to the changed hunk that introduced the defect.

Every old-side target and every `<related-change>` must overlap the corresponding side of a local
change. Do not output revisions, IDs, confidence fields, anchors, context counts, or runtime
annotation metadata. The runtime owns those fields. Escape XML text and attribute values as required
above. Title and content are plain text, not Markdown.

Deletion examples:

When deleting the selected lines is itself the defect, target the old side:

<finding priority="P1">
  <target type="line-range" path="packages/example.ts" side="old" start-line="174" end-line="177" />
  <title>Required state calculation was removed</title>
  <content>The remaining code still reads this state, so this path now fails.</content>
</finding>

When the comment belongs on surviving code, target that current line and identify the introducing
deletion through `<related-change>`:

<finding priority="P1">
  <target type="line-range" path="packages/example.ts" side="new" start-line="179" end-line="179" />
  <related-change path="packages/example.ts" side="old" start-line="174" end-line="177" />
  <title>Removed state is still referenced</title>
  <content>This surviving call still reads the state deleted by the local change.</content>
</finding>

For an issue caused by deleting an entire file, use a file target:

<finding priority="P1">
  <target type="file" path="packages/removed.ts" state="deleted" />
  <title>Deleted module is still imported</title>
  <content>A surviving entry point still imports this module and will fail to load.</content>
</finding>

If the runtime asks for candidate corrections, return exactly one correction document and do not
repeat findings that already passed validation:

<review-candidate-corrections version="1">
  <correction candidate-key="finding_2" action="replace">
    <finding priority="P1">
      <target type="line-range" path="packages/example.ts" side="old" start-line="174" end-line="177" />
      <title>Required state calculation was removed</title>
      <content>The remaining code still reads this state, so this path now fails.</content>
    </finding>
  </correction>
</review-candidate-corrections>

Copy every supplied `candidate-key` exactly. Use `action="replace"` with one corrected `<finding>`,
or an empty `<correction candidate-key="..." action="drop" />` when the original issue is not valid.
Do not introduce new candidate keys.
