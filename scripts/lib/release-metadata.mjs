import { readFileSync } from "node:fs";
import path from "node:path";

// Canonical locations of the machine-read release contracts. These are build and
// verification inputs, not documentation: `release/extraction.json` pins the source
// baseline and package scope, `release/public-source.json` is the reviewed file
// inventory, and `release/dependency-licenses.json` records declared dependency
// licenses. Import these constants instead of repeating the literal paths.
export const extractionPath = "release/extraction.json";
export const inventoryPath = "release/public-source.json";
export const dependencyLicensesPath = "release/dependency-licenses.json";

function readJson(root, relative) {
  return JSON.parse(readFileSync(path.join(root, relative), "utf8"));
}

export function readExtraction(root) {
  return readJson(root, extractionPath);
}

export function readInventory(root) {
  return readJson(root, inventoryPath);
}
