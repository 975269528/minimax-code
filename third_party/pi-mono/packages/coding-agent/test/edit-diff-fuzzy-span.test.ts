import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	applyEditsToNormalizedContent,
	fuzzyFindText,
	isDisproportionateMatch,
	normalizeForFuzzyMatch,
} from "../src/core/tools/edit-diff.ts";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-edit-fuzzy-span-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

// Unicode building blocks (kept as escapes so the test file itself stays ASCII-safe).
const LSQ = "‘"; // left single smart quote
const RSQ = "’"; // right single smart quote
const LDQ = "“"; // left double smart quote
const RDQ = "”"; // right double smart quote
const EMDASH = "—";
const ENDASH = "–";
const IDEOSPACE = "　"; // full-width ideographic space
const FW_A = "ａ"; // full-width 'a'
const FW_FOO = "ｆｏｏ"; // full-width 'foo'
const FW_BAR = "ｂａｒ"; // full-width 'bar'
const COMBINING_ACUTE = "́";
const BOM = "﻿";

describe("fuzzy matching stays scoped to the matched span", () => {
	it("keeps exact-match behavior unchanged", () => {
		const content = "line one\nline two\nline three\n";
		const result = applyEditsToNormalizedContent(content, [{ oldText: "line two", newText: "LINE TWO" }], "f.txt");
		expect(result.baseContent).toBe(content);
		expect(result.newContent).toBe("line one\nLINE TWO\nline three\n");
	});

	it("fails closed instead of swallowing a compat ligature the oldText only partly names", () => {
		// "ﬁ" (U+FB01) NFKC-normalizes to "fi", so a model oldText of "ix"
		// matches in normalized space ("fix") starting INSIDE the ligature.
		// The back-map widens outward and would map onto the whole "ﬁx",
		// silently destroying the ligature the model never named. The fidelity
		// guard must reject the ambiguous match rather than clobber those bytes.
		const content = "ﬁx = 1\n";
		const match = fuzzyFindText(content, "ix");
		expect(match.found).toBe(false);
		expect(() =>
			applyEditsToNormalizedContent(content, [{ oldText: "ix", newText: "IX" }], "f.txt"),
		).toThrow();
	});

	it("still applies a fuzzy edit that names a full-width run cleanly (guard is not over-strict)", () => {
		// oldText fully covers the full-width token in normalized space, so the
		// mapped span re-normalizes to exactly the located text — must succeed.
		const content = `x = ${FW_FOO}\n`;
		const result = applyEditsToNormalizedContent(content, [{ oldText: "x = foo", newText: "x = bar" }], "f.txt");
		expect(result.newContent).toBe("x = bar\n");
	});

	it("does not rewrite unrelated smart quotes / dashes / trailing whitespace when one edit matches fuzzily", () => {
		// Target line uses smart quotes; the model supplies ASCII quotes -> fuzzy match.
		// Every other line carries Unicode / whitespace quirks that must survive byte-for-byte.
		const lines = [
			`const a = "keep ${LDQ}these${RDQ} quotes";`, // smart double quotes, must survive
			`const target = ${LSQ}hello${RSQ};`, // smart single quotes, edit target
			`const dash = ${EMDASH}em${EMDASH};`, // em dashes, must survive
			"const pad = 1;   ", // trailing spaces, must survive
			`const wide = ${IDEOSPACE}indent;`, // ideographic space, must survive
		];
		const content = `${lines.join("\n")}\n`;
		const result = applyEditsToNormalizedContent(
			content,
			[{ oldText: "const target = 'hello';", newText: "const target = 'world';" }],
			"f.ts",
		);
		expect(result.baseContent).toBe(content);
		const newLines = result.newContent.split("\n");
		expect(newLines[0]).toBe(lines[0]);
		expect(newLines[1]).toBe("const target = 'world';");
		expect(newLines[2]).toBe(lines[2]);
		expect(newLines[3]).toBe(lines[3]);
		expect(newLines[4]).toBe(lines[4]);
	});

	it("preserves trailing whitespace on untouched lines when the match needed trailing-whitespace tolerance", () => {
		const content = "alpha = 1;  \nbeta = 2;\t\ngamma = 3;\n";
		// oldText spans the newline but omits the trailing spaces present in the file -> fuzzy path.
		const result = applyEditsToNormalizedContent(
			content,
			[{ oldText: "alpha = 1;\nbeta", newText: "alpha = 10;\nbeta" }],
			"f.ts",
		);
		expect(result.newContent).toBe("alpha = 10;\nbeta = 2;\t\ngamma = 3;\n");
	});

	it("replaces a multi-line fuzzy span without touching surrounding lines", () => {
		const content = `before  \nfoo(${LDQ}x${RDQ});\nbar();  \nafter${EMDASH}line\n`;
		const result = applyEditsToNormalizedContent(
			content,
			[{ oldText: 'foo("x");\nbar();', newText: "baz();" }],
			"f.ts",
		);
		// The matched span excludes bar()'s trailing spaces, so they survive after newText.
		expect(result.newContent).toBe(`before  \nbaz();  \nafter${EMDASH}line\n`);
	});

	it("applies mixed exact and fuzzy edits at their original locations", () => {
		const content = `keep ${LDQ}quote${RDQ}\nexact target\nfuzzy ${LSQ}target${RSQ}\ntail  \n`;
		const result = applyEditsToNormalizedContent(
			content,
			[
				{ oldText: "exact target", newText: "exact done" },
				{ oldText: "fuzzy 'target'", newText: "fuzzy done" },
			],
			"f.txt",
		);
		expect(result.newContent).toBe(`keep ${LDQ}quote${RDQ}\nexact done\nfuzzy done\ntail  \n`);
	});

	it("maps spans correctly on lines with full-width (NFKC-expanding) characters", () => {
		// Full-width latin letters normalize to ASCII under NFKC; untouched lines must survive.
		const content = `${FW_FOO} = 1\nvalue = ${LSQ}2${RSQ}\n${FW_BAR} = 3\n`;
		const result = applyEditsToNormalizedContent(
			content,
			[{ oldText: "value = '2'", newText: "value = '20'" }],
			"f.txt",
		);
		expect(result.newContent).toBe(`${FW_FOO} = 1\nvalue = '20'\n${FW_BAR} = 3\n`);
	});

	it("edits a fuzzy span on the same line as combining marks without corrupting them", () => {
		// "cafe" + combining acute precedes the target on the same line.
		const content = `cafe${COMBINING_ACUTE} price = ${LDQ}1${RDQ}\nother\n`;
		const result = applyEditsToNormalizedContent(
			content,
			[{ oldText: 'price = "1"', newText: 'price = "2"' }],
			"f.txt",
		);
		expect(result.newContent).toBe(`cafe${COMBINING_ACUTE} price = "2"\nother\n`);
	});

	it("returns original-space coordinates from fuzzyFindText for fuzzy matches", () => {
		const content = `pad  \nsay ${LDQ}hi${RDQ} now\n`;
		const match = fuzzyFindText(content, 'say "hi" now');
		expect(match.found).toBe(true);
		expect(match.usedFuzzyMatch).toBe(true);
		expect(content.slice(match.index, match.index + match.matchLength)).toBe(`say ${LDQ}hi${RDQ} now`);
	});

	it("normalizes quotes, dashes, spaces, NFKC and trailing whitespace exactly as before", () => {
		const sample = `a${RSQ}b  \n${LDQ}c${RDQ}${EMDASH}d\u00A0e\n${FW_A} line${IDEOSPACE}\nplain\n`;
		expect(normalizeForFuzzyMatch(sample)).toBe(`a'b\n"c"-d e\na line\nplain\n`);
	});
});

describe("error reporting", () => {
	it("suggests re-reading the file when the text is not found", () => {
		expect(() =>
			applyEditsToNormalizedContent("some content\n", [{ oldText: "missing", newText: "x" }], "f.txt"),
		).toThrow(/read/i);
	});

	it("reports match line numbers on duplicate matches", () => {
		const content = "dup\nunique\ndup\ntail\n";
		expect(() => applyEditsToNormalizedContent(content, [{ oldText: "dup", newText: "x" }], "f.txt")).toThrow(
			/lines 1, 3/,
		);
	});

	it("still rejects empty oldText", () => {
		expect(() => applyEditsToNormalizedContent("abc\n", [{ oldText: "", newText: "x" }], "f.txt")).toThrow(
			/must not be empty/,
		);
	});

	it("still rejects overlapping edits", () => {
		const content = "one two three\n";
		expect(() =>
			applyEditsToNormalizedContent(
				content,
				[
					{ oldText: "one two", newText: "a" },
					{ oldText: "two three", newText: "b" },
				],
				"f.txt",
			),
		).toThrow(/overlap/);
	});

	it("still rejects no-op replacements", () => {
		expect(() => applyEditsToNormalizedContent("abc\n", [{ oldText: "abc", newText: "abc" }], "f.txt")).toThrow(
			/No changes made/,
		);
	});
});

describe("isDisproportionateMatch", () => {
	it("accepts a match of similar size", () => {
		expect(isDisproportionateMatch("const a = 1;", "const a = 1;  ")).toBe(false);
	});

	it("rejects a match spanning far more lines than oldText", () => {
		const oldText = "a";
		const matched = "a\nb\nc\nd";
		expect(isDisproportionateMatch(matched, oldText)).toBe(true);
	});

	it("rejects a multi-line match with disproportionate character count", () => {
		const oldText = "ab\ncd";
		const matched = `ab${"x".repeat(600)}\ncd`;
		expect(isDisproportionateMatch(matched, oldText)).toBe(true);
	});

	it("accepts a multi-line match within the character budget", () => {
		const oldText = "ab\ncd";
		const matched = "ab \ncd";
		expect(isDisproportionateMatch(matched, oldText)).toBe(false);
	});
});

describe("end-to-end through the edit tool", () => {
	async function runEdit(dir: string, fileName: string, raw: string, edits: unknown): Promise<string> {
		const filePath = join(dir, fileName);
		await writeFile(filePath, raw);
		const tool = createEditToolDefinition(dir);
		await tool.execute("call-1", { path: fileName, edits } as never, undefined);
		return readFile(filePath, "utf-8");
	}

	it("preserves CRLF line endings and unrelated bytes on a fuzzy edit", async () => {
		const dir = await createTempDir();
		const raw = `keep ${LDQ}q${RDQ}\r\ntarget = ${LSQ}a${RSQ}\r\ntrail  \r\n`;
		const result = await runEdit(dir, "crlf.txt", raw, [{ oldText: "target = 'a'", newText: "target = 'b'" }]);
		expect(result).toBe(`keep ${LDQ}q${RDQ}\r\ntarget = 'b'\r\ntrail  \r\n`);
	});

	it("preserves the BOM and untouched full-width characters", async () => {
		const dir = await createTempDir();
		const raw = `${BOM}${FW_A} = 1\ntarget ${EMDASH} x\n`;
		const result = await runEdit(dir, "bom.txt", raw, [{ oldText: "target - x", newText: "target - y" }]);
		expect(result).toBe(`${BOM}${FW_A} = 1\ntarget - y\n`);
	});

	it("produces a byte-exact file when only one line is edited fuzzily", async () => {
		const dir = await createTempDir();
		const lines = [
			"alpha  ",
			`${LDQ}beta${RDQ}`,
			`gamma = ${LSQ}1${RSQ}`,
			`${IDEOSPACE}delta`,
			`epsilon${ENDASH}zeta`,
		];
		const raw = `${lines.join("\n")}\n`;
		const result = await runEdit(dir, "mixed.txt", raw, [{ oldText: "gamma = '1'", newText: "gamma = '2'" }]);
		expect(result).toBe(`${lines[0]}\n${lines[1]}\ngamma = '2'\n${lines[3]}\n${lines[4]}\n`);
	});
});
