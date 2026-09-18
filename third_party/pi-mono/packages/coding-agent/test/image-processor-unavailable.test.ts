import { describe, expect, it, vi } from "vitest";

vi.mock("../src/utils/photon.ts", () => ({
	loadPhoton: vi.fn(async () => null),
}));

import {
	ImageProcessorUnavailableError,
	resizeImageInProcess,
} from "../src/utils/image-resize-core.ts";

function pngHeader(width: number, height: number, totalBytes = 24): Buffer {
	const bytes = Buffer.alloc(totalBytes);
	Buffer.from("89504e470d0a1a0a", "hex").copy(bytes);
	bytes.writeUInt32BE(13, 8);
	bytes.write("IHDR", 12, "ascii");
	bytes.writeUInt32BE(width, 16);
	bytes.writeUInt32BE(height, 20);
	return bytes;
}

describe("resizeImageInProcess without Photon", () => {
	it.each([
		["PNG", "image/png", pngHeader(20, 10)],
		[
			"JPEG",
			"image/jpeg",
			Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x0a, 0x00, 0x14]),
		],
		["GIF", "image/gif", Buffer.from("47494638396114000a00", "hex")],
		[
			"WebP",
			"image/webp",
			Buffer.from("524946461600000057454250565038580000000000000000130000090000", "hex"),
		],
	])("returns an already-safe %s without an image processor", async (_label, mimeType, bytes) => {
		const result = await resizeImageInProcess(bytes, mimeType);

		expect(result).toEqual({
			data: bytes.toString("base64"),
			mimeType,
			originalWidth: 20,
			originalHeight: 10,
			width: 20,
			height: 10,
			wasResized: false,
		});
	});

	it("still reports an unavailable processor when the image exceeds dimension limits", async () => {
		await expect(resizeImageInProcess(pngHeader(2001, 1200), "image/png")).rejects.toBeInstanceOf(
			ImageProcessorUnavailableError,
		);
	});

	it("still reports an unavailable processor when the encoded image exceeds the size limit", async () => {
		await expect(
			resizeImageInProcess(pngHeader(20, 10), "image/png", { maxBytes: 31 }),
		).rejects.toBeInstanceOf(ImageProcessorUnavailableError);
	});

	it("still reports an unavailable processor when dimensions cannot be verified", async () => {
		await expect(
			resizeImageInProcess(Buffer.from("not-an-image"), "image/png"),
		).rejects.toBeInstanceOf(ImageProcessorUnavailableError);
	});

	it("does not treat a truncated JPEG marker sequence as a safe image", async () => {
		const truncated = Buffer.from([0xff, 0xd8, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xc0]);

		await expect(resizeImageInProcess(truncated, "image/jpeg")).rejects.toBeInstanceOf(
			ImageProcessorUnavailableError,
		);
	});
});
