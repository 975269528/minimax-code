import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readExtraction, extractionPath } from "./lib/release-metadata.mjs";
import { packageExportEntries } from "./lib/package-exports.mjs";

// The standalone type-check path map is derived from the package scope in
// `release/extraction.json` plus each package's own `exports`, so adding a package
// or an export subpath never requires hand-editing 100+ path entries. Run with
// `--write` after changing package scope or exports; the default check mode fails
// when the committed map has drifted.
const root = fileURLToPath(new URL("../", import.meta.url));
const configPath = "tsconfig.standalone.json";
const { packageRoots } = readExtraction(root);

const paths = {};
for (const { specifier, file } of packageExportEntries(root, packageRoots)) {
  if (paths[specifier])
    throw new Error(
      `Duplicate export specifier ${specifier} in ${paths[specifier][0]} and ./${file}`,
    );
  paths[specifier] = [`./${file}`];
}
const expected = Object.fromEntries(
  Object.keys(paths)
    .sort()
    .map((specifier) => [specifier, paths[specifier]]),
);

const config = JSON.parse(readFileSync(path.join(root, configPath), "utf8"));
const serialize = (value) => JSON.stringify(value, null, 2) + "\n";

if (process.argv.includes("--write")) {
  config.compilerOptions.paths = expected;
  writeFileSync(path.join(root, configPath), serialize(config));
  console.log(
    `Recorded ${Object.keys(expected).length} package paths in ${configPath}.`,
  );
} else {
  const actual = config.compilerOptions.paths ?? {};
  const drift = [
    ...Object.keys(expected)
      .filter((key) => serialize(actual[key]) !== serialize(expected[key]))
      .map((key) => `${key}: expected ${expected[key][0]}, found ${actual[key]?.[0] ?? "nothing"}`),
    ...Object.keys(actual)
      .filter((key) => !(key in expected))
      .map((key) => `${key}: not declared by any package in ${extractionPath}`),
  ];
  if (drift.length)
    throw new Error(
      `${configPath} paths are stale; run \`pnpm gen:tsconfig\`:\n${drift.join("\n")}`,
    );
  console.log(
    `${configPath} paths match ${Object.keys(expected).length} package exports.`,
  );
}
