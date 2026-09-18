import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readExtraction } from "./scripts/lib/release-metadata.mjs";
import { packageExportEntries } from "./scripts/lib/package-exports.mjs";
import { allSuiteFiles } from "./scripts/lib/vitest-suites.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const { packageRoots } = readExtraction(root);
const alias = packageExportEntries(root, packageRoots).map(
  ({ specifier, file }) => ({
    find: new RegExp(`^${specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
    replacement: path.join(root, file),
  }),
);
export default defineConfig({
  resolve: { alias },
  test: {
    environment: "node",
    include: allSuiteFiles(root),
  },
});
