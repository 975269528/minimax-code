export interface RgbColor {
	r: number;
	g: number;
	b: number;
}

export type TerminalColorScheme = "dark" | "light";

function hexToRgb(hex: string): RgbColor {
	const normalized = hex.startsWith("#") ? hex.slice(1) : hex;
	const r = parseInt(normalized.slice(0, 2), 16);
	const g = parseInt(normalized.slice(2, 4), 16);
	const b = parseInt(normalized.slice(4, 6), 16);
	return { r, g, b };
}

function parseOscHexChannel(channel: string): number | undefined {
	if (!/^[0-9a-f]+$/i.test(channel)) {
		return undefined;
	}
	const max = 16 ** channel.length - 1;
	if (max <= 0) {
		return undefined;
	}
	return Math.round((parseInt(channel, 16) / max) * 255);
}

const OSC11_BACKGROUND_COLOR_RESPONSE_PATTERN = /^\x1b\]11;([^\x07\x1b]*)(?:\x07|\x1b\\)$/i;
const COLOR_SCHEME_REPORT_PATTERN = /^(?:\x1b\[\?997;(1|2)n)+$/;
const OSC11_BACKGROUND_COLOR_SEQUENCE_PATTERN = /\x1b\]11;([^\x07\x1b]*)(?:\x07|\x1b\\)/i;
const COLOR_SCHEME_REPORT_SEQUENCE_SOURCE = "\\x1b\\[\\?997;(1|2)n";
/** Cheap guards so a large paste is not scanned by the sequence patterns. */
const OSC11_BACKGROUND_COLOR_PREFIX = "\x1b]11;";
const COLOR_SCHEME_REPORT_PREFIX = "\x1b[?997;";

export interface ExtractedTerminalSequence<TValue> {
	/** Parsed payload of the extracted sequence. */
	value: TValue;
	/** Input with the extracted sequence removed, so unrelated bytes stay dispatchable. */
	rest: string;
}

export function isOsc11BackgroundColorResponse(data: string): boolean {
	return OSC11_BACKGROUND_COLOR_RESPONSE_PATTERN.test(data);
}

function parseOsc11ColorPayload(payload: string): RgbColor | undefined {
	const value = payload.trim();
	if (value.startsWith("#")) {
		const hex = value.slice(1);
		if (/^[0-9a-f]{6}$/i.test(hex)) {
			return hexToRgb(value);
		}
		if (/^[0-9a-f]{12}$/i.test(hex)) {
			const r = parseOscHexChannel(hex.slice(0, 4));
			const g = parseOscHexChannel(hex.slice(4, 8));
			const b = parseOscHexChannel(hex.slice(8, 12));
			return r !== undefined && g !== undefined && b !== undefined ? { r, g, b } : undefined;
		}
		return undefined;
	}

	const rgbValue = value.replace(/^rgba?:/i, "");
	const [red, green, blue] = rgbValue.split("/");
	if (red === undefined || green === undefined || blue === undefined) {
		return undefined;
	}
	const r = parseOscHexChannel(red);
	const g = parseOscHexChannel(green);
	const b = parseOscHexChannel(blue);
	return r !== undefined && g !== undefined && b !== undefined ? { r, g, b } : undefined;
}

export function parseOsc11BackgroundColor(data: string): RgbColor | undefined {
	const match = data.match(OSC11_BACKGROUND_COLOR_RESPONSE_PATTERN);
	if (!match) {
		return undefined;
	}
	return parseOsc11ColorPayload(match[1]!);
}

/**
 * Locate an OSC 11 background reply anywhere inside a read chunk. Terminals answer
 * asynchronously, so a reply can arrive coalesced with unrelated input; the anchored
 * parser only matches a chunk that holds the reply and nothing else.
 */
export function extractOsc11BackgroundColorResponse(
	data: string,
): ExtractedTerminalSequence<RgbColor | undefined> | undefined {
	if (!data.includes(OSC11_BACKGROUND_COLOR_PREFIX)) {
		return undefined;
	}
	const match = data.match(OSC11_BACKGROUND_COLOR_SEQUENCE_PATTERN);
	if (!match || match.index === undefined) {
		return undefined;
	}
	return {
		value: parseOsc11ColorPayload(match[1]!),
		rest: data.slice(0, match.index) + data.slice(match.index + match[0].length),
	};
}

export function parseTerminalColorSchemeReport(data: string): TerminalColorScheme | undefined {
	const match = data.match(COLOR_SCHEME_REPORT_PATTERN);
	if (!match) {
		return undefined;
	}
	return match[1] === "2" ? "light" : "dark";
}

/**
 * Locate DEC 2031 color-scheme reports anywhere inside a read chunk. Every occurrence is
 * removed and the last one wins, matching the anchored parser's collapse of repeated
 * reports while tolerating surrounding input.
 */
export function extractTerminalColorSchemeReport(
	data: string,
): ExtractedTerminalSequence<TerminalColorScheme> | undefined {
	if (!data.includes(COLOR_SCHEME_REPORT_PREFIX)) {
		return undefined;
	}
	const pattern = new RegExp(COLOR_SCHEME_REPORT_SEQUENCE_SOURCE, "g");
	let scheme: TerminalColorScheme | undefined;
	let rest = "";
	let offset = 0;
	for (let match = pattern.exec(data); match; match = pattern.exec(data)) {
		rest += data.slice(offset, match.index);
		offset = match.index + match[0].length;
		scheme = match[1] === "2" ? "light" : "dark";
	}
	if (!scheme) {
		return undefined;
	}
	return { value: scheme, rest: rest + data.slice(offset) };
}
