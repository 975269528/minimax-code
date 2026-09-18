import { readFileSync } from "node:fs";
import path from "node:path";

// Single derivation of "package export specifier -> source file" for the workspace.
// The published packages point at built `dist` output, but every in-repository
// consumer (type checking, Vitest resolution) must resolve the TypeScript source
// instead. Keeping one implementation prevents the type-check path map and the test
// resolver from disagreeing about the same package.
function sourceOf(target) {
  return target
    .replace(/^\.\/dist\//u, "./src/")
    .replace(/\.d\.ts$/u, ".ts")
    .replace(/\.js$/u, ".ts");
}

export function packageExportEntries(root, packageRoots) {
  const entries = [];
  for (const directory of packageRoots) {
    const manifest = JSON.parse(
      readFileSync(path.join(root, directory, "package.json"), "utf8"),
    );
    for (const [subpath, value] of Object.entries(
      manifest.exports ?? { ".": manifest.types },
    )) {
      const target =
        typeof value === "string"
          ? value
          : (value?.types ?? value?.import ?? value?.default);
      if (!target || !subpath.startsWith(".")) continue;
      const specifier = manifest.name + (subpath === "." ? "" : subpath.slice(1));
      const source = sourceOf(target);
      entries.push({
        specifier,
        directory,
        // Repository-relative POSIX path to the source entry point.
        file: `${directory}/${source.replace(/^\.\//u, "")}`,
      });
    }
  }
  return entries;
}
