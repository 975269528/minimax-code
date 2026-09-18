import { copyFile, mkdir, readdir } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FILE_PATHS = [
	"core/export-html/template.html",
	"core/export-html/template.css",
	"core/export-html/template.js",
];

async function copyPath(sourceRoot, distRoot, relativePath) {
	const destination = resolve(distRoot, relativePath);
	await mkdir(dirname(destination), { recursive: true });
	await copyFile(resolve(sourceRoot, relativePath), destination);
}

async function copyMatchingFiles(sourceRoot, distRoot, relativeDir, extension) {
	const entries = await readdir(resolve(sourceRoot, relativeDir), { withFileTypes: true });
	await Promise.all(
		entries
			.filter((entry) => entry.isFile() && extname(entry.name) === extension)
			.map((entry) => copyPath(sourceRoot, distRoot, join(relativeDir, entry.name))),
	);
}

export async function copyCodingAgentAssets({ sourceRoot, distRoot }) {
	await Promise.all([
		...FILE_PATHS.map((relativePath) => copyPath(sourceRoot, distRoot, relativePath)),
		copyMatchingFiles(sourceRoot, distRoot, "modes/interactive/theme", ".json"),
		copyMatchingFiles(sourceRoot, distRoot, "modes/interactive/assets", ".png"),
		copyMatchingFiles(sourceRoot, distRoot, "core/export-html/vendor", ".js"),
	]);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
	await copyCodingAgentAssets({ sourceRoot: resolve("src"), distRoot: resolve("dist") });
}
