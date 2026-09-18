import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { copyCodingAgentAssets } from "./copy-assets.mjs";

test("copies coding-agent runtime assets without relying on shell commands", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-copy-assets-"));
	const sourceRoot = join(root, "src");
	const distRoot = join(root, "dist");

	try {
		const fixtures = [
			["modes/interactive/theme/dark.json", "theme"],
			["modes/interactive/assets/logo.png", "image"],
			["core/export-html/template.html", "html"],
			["core/export-html/template.css", "css"],
			["core/export-html/template.js", "script"],
			["core/export-html/vendor/highlight.js", "vendor"],
		];

		for (const [relativePath, contents] of fixtures) {
			const path = join(sourceRoot, relativePath);
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, contents);
		}
		await writeFile(join(sourceRoot, "modes/interactive/theme/ignored.txt"), "ignored");

		await copyCodingAgentAssets({ sourceRoot, distRoot });

		for (const [relativePath, contents] of fixtures) {
			assert.equal(await readFile(join(distRoot, relativePath), "utf8"), contents);
		}
		await assert.rejects(readFile(join(distRoot, "modes/interactive/theme/ignored.txt")));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("the package copy-assets command does not require shx", async () => {
	const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
	assert.equal(packageJson.scripts["copy-assets"], "node scripts/copy-assets.mjs");
});
