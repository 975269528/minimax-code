import { Input } from "./components/input.js";
import type { Component, Focusable } from "./tui.js";
import { getGraphemeSegmenter, stripTerminalSequences, truncateToWidth, visibleWidth } from "./utils.js";

const segmenter = getGraphemeSegmenter();

interface SearchSourceSpan {
	row: number;
	startCol: number;
	endCol: number;
}

export interface AltScreenSearchSegment {
	row: number;
	startCol: number;
	endCol: number;
}

export interface AltScreenSearchMatch {
	segments: AltScreenSearchSegment[];
}

function appendMappedText(
	text: string,
	span: SearchSourceSpan | undefined,
	corpus: { text: string; source: Array<SearchSourceSpan | undefined> },
): void {
	corpus.text += text;
	for (let index = 0; index < text.length; index++) corpus.source.push(span);
}

function buildSearchCorpus(lines: readonly string[]): {
	text: string;
	source: Array<SearchSourceSpan | undefined>;
} {
	const corpus: { text: string; source: Array<SearchSourceSpan | undefined> } = {
		text: "",
		source: [],
	};
	let pendingSeparator = false;

	for (let row = 0; row < lines.length; row++) {
		const line = stripTerminalSequences(lines[row] ?? "");
		let column = 0;
		for (const grapheme of segmenter.segment(line)) {
			const text = grapheme.segment;
			const width = visibleWidth(text);
			if (/^\s+$/u.test(text)) {
				if (corpus.text.length > 0) pendingSeparator = true;
				column += width;
				continue;
			}
			if (pendingSeparator) {
				appendMappedText(" ", undefined, corpus);
				pendingSeparator = false;
			}
			appendMappedText(text, { row, startCol: column, endCol: column + width }, corpus);
			column += width;
		}
		if (corpus.text.length > 0) pendingSeparator = true;
	}

	return corpus;
}

function normalizeQuery(query: string): string {
	return query.replace(/\s+/gu, " ").trim();
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function findAltScreenSearchMatches(lines: readonly string[], query: string): AltScreenSearchMatch[] {
	const normalizedQuery = normalizeQuery(query);
	if (!normalizedQuery) return [];

	const corpus = buildSearchCorpus(lines);
	return matchSearchCorpus(corpus, normalizedQuery);
}

function matchSearchCorpus(
	corpus: ReturnType<typeof buildSearchCorpus>,
	normalizedQuery: string,
): AltScreenSearchMatch[] {
	const expression = new RegExp(escapeRegExp(normalizedQuery), "giu");
	const matches: AltScreenSearchMatch[] = [];

	for (const match of corpus.text.matchAll(expression)) {
		const start = match.index;
		const end = start + match[0].length;
		const segments: AltScreenSearchSegment[] = [];
		for (let index = start; index < end; index++) {
			const span = corpus.source[index];
			if (!span) continue;
			const previous = segments[segments.length - 1];
			if (previous && previous.row === span.row && span.startCol <= previous.endCol) {
				previous.endCol = Math.max(previous.endCol, span.endCol);
			} else {
				segments.push({ ...span });
			}
		}
		if (segments.length > 0) matches.push({ segments });
	}

	return matches;
}

/** One active search owns one corpus and one result set; closing it releases both. */
export class AltScreenSearchIndex {
	private lines: readonly string[] = [];
	private width: number | undefined;
	private corpus: ReturnType<typeof buildSearchCorpus> | undefined;
	private query: string | undefined;
	private matches: AltScreenSearchMatch[] = [];

	find(lines: readonly string[], query: string, width: number): AltScreenSearchMatch[] {
		const normalizedQuery = normalizeQuery(query);
		if (!normalizedQuery) return [];
		// Layout can allocate a new array on every frame. Compare immutable line strings,
		// not array identity, and retain a copy to detect callers mutating their array.
		if (
			this.width !== width ||
			lines.length !== this.lines.length ||
			lines.some((line, index) => line !== this.lines[index])
		) {
			this.lines = [...lines];
			this.width = width;
			this.corpus = undefined;
			this.query = undefined;
		}
		this.corpus ??= buildSearchCorpus(lines);
		if (this.query !== normalizedQuery) {
			this.matches = matchSearchCorpus(this.corpus, normalizedQuery);
			this.query = normalizedQuery;
		}
		return this.matches;
	}
}

export function getAltScreenSearchMatchKey(match: AltScreenSearchMatch): string {
	const first = match.segments[0];
	const last = match.segments[match.segments.length - 1];
	return first && last ? `${first.row}:${first.startCol}:${last.row}:${last.endCol}` : "";
}

export class AltScreenSearchComponent implements Component, Focusable {
	private readonly input = new Input();
	private readonly onQueryChange: (query: string) => void;
	private resultCount = 0;
	private resultIndex = -1;
	private _focused = false;

	constructor(onQueryChange: (query: string) => void) {
		this.onQueryChange = onQueryChange;
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	setResult(index: number, count: number): void {
		this.resultIndex = index;
		this.resultCount = count;
	}

	handleInput(data: string): void {
		const previous = this.input.getValue();
		this.input.handleInput(data);
		const query = this.input.getValue();
		if (query !== previous) this.onQueryChange(query);
	}

	invalidate(): void {
		this.input.invalidate();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const label = " Find transcript";
		const query = this.input.getValue();
		const status = !query
			? ""
			: this.resultCount === 0
				? "No matches "
				: `${this.resultIndex + 1}/${this.resultCount} `;
		const labelWidth = visibleWidth(label);
		const statusWidth = visibleWidth(status);
		const gap = " ".repeat(Math.max(1, safeWidth - labelWidth - statusWidth));
		const title = truncateToWidth(`${label}${gap}${status}`, safeWidth, "");
		const padding = " ".repeat(Math.max(0, safeWidth - visibleWidth(title)));
		return [`\x1b[7m${title}${padding}\x1b[27m`, ...this.input.render(safeWidth)];
	}
}
