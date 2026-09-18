import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export function classifyChanges(files) {
  // Unknown paths, empty comparisons and release metadata always get full CI.
  const documentation = (p) =>
    [
      "README.md",
      "README_ZH.md",
      "CONTRIBUTING.md",
      ".github/PULL_REQUEST_TEMPLATE.md",
    ].includes(p) ||
    /^docs\/(?:[^/]+\/)*[^/]+\.md$/u.test(p) ||
    /^docs\/assets\/[^/]+\.(?:png|jpg|svg|gif|mp4)$/u.test(p);
  return {
    docsOnly: files.length > 0 && files.every(documentation),
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const base =
    process.env.GITHUB_EVENT_NAME === "pull_request"
      ? event.pull_request?.base?.sha
      : process.env.GITHUB_EVENT_NAME === "push"
        ? event.before
        : undefined;
  let result = { docsOnly: false };
  if (/^[a-f0-9]{40}$/u.test(base ?? "") && !/^0+$/u.test(base)) {
    // --no-renames includes both removed and added paths, preventing a code file
    // renamed into docs from becoming an accidental documentation-only change.
    const diff = spawnSync(
      "git",
      ["diff", "--name-only", "--no-renames", "-z", base, "HEAD"],
      { encoding: "utf8" },
    );
    if (diff.status === 0)
      result = classifyChanges(diff.stdout.split("\0").filter(Boolean));
  }
  const output = `docs_only=${result.docsOnly}\n`;
  console.log(output.trim());
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, output);
}
