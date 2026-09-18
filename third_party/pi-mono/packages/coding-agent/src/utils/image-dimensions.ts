export interface ImageDimensions {
	width: number;
	height: number;
}

/**
 * Read dimensions from the headers of image formats supported by the read tool.
 * This is intentionally a narrow header check, not a replacement for decoding:
 * it is used only to decide whether an original image is already safe to return
 * when the full image processor cannot be loaded.
 */
export function readImageDimensions(bytes: Uint8Array, mimeType: string): ImageDimensions | undefined {
	const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	switch (mimeType) {
		case "image/png":
			return readPngDimensions(buffer);
		case "image/jpeg":
			return readJpegDimensions(buffer);
		case "image/gif":
			return readGifDimensions(buffer);
		case "image/webp":
			return readWebpDimensions(buffer);
		default:
			return undefined;
	}
}

function readPngDimensions(buffer: Buffer): ImageDimensions | undefined {
	if (
		buffer.length < 24 ||
		!buffer.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) ||
		buffer.readUInt32BE(8) !== 13 ||
		buffer.toString("ascii", 12, 16) !== "IHDR"
	) {
		return undefined;
	}
	return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function readJpegDimensions(buffer: Buffer): ImageDimensions | undefined {
	if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return undefined;

	const startOfFrameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
	let offset = 2;
	while (offset + 8 < buffer.length) {
		if (buffer[offset] !== 0xff) {
			offset += 1;
			continue;
		}
		while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
		const marker = buffer[offset];
		if (marker === undefined || marker === 0xda || marker === 0xd9) return undefined;
		if (startOfFrameMarkers.has(marker)) {
			if (offset + 7 >= buffer.length || buffer.readUInt16BE(offset + 1) < 8) return undefined;
			return { width: buffer.readUInt16BE(offset + 6), height: buffer.readUInt16BE(offset + 4) };
		}
		if (marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
			offset += 1;
			continue;
		}
		if (offset + 2 >= buffer.length) return undefined;
		const segmentLength = buffer.readUInt16BE(offset + 1);
		if (segmentLength < 2) return undefined;
		offset += segmentLength + 1;
	}
	return undefined;
}

function readGifDimensions(buffer: Buffer): ImageDimensions | undefined {
	if (buffer.length < 10) return undefined;
	const signature = buffer.toString("ascii", 0, 6);
	if (signature !== "GIF87a" && signature !== "GIF89a") return undefined;
	return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
}

function readWebpDimensions(buffer: Buffer): ImageDimensions | undefined {
	if (buffer.length < 30 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WEBP") {
		return undefined;
	}

	const chunk = buffer.toString("ascii", 12, 16);
	if (chunk === "VP8 ") {
		if (!buffer.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))) return undefined;
		return {
			width: buffer.readUInt16LE(26) & 0x3fff,
			height: buffer.readUInt16LE(28) & 0x3fff,
		};
	}
	if (chunk === "VP8L") {
		if (buffer[20] !== 0x2f) return undefined;
		const bits = buffer.readUInt32LE(21);
		return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
	}
	if (chunk === "VP8X") {
		return {
			width: buffer.readUIntLE(24, 3) + 1,
			height: buffer.readUIntLE(27, 3) + 1,
		};
	}
	return undefined;
}
