import { readFileSync } from "node:fs";
import { retiredBuildInputs } from "./lib/retired-sources.mjs";

// Validate the actual build dependency graph; source-inventory.mjs checks raw sources separately.
const metafile = JSON.parse(
  readFileSync(new URL("../dist/metafile.json", import.meta.url), "utf8"),
);
const violations = Object.keys(metafile.inputs).filter((input) =>
  retiredBuildInputs.some((prefix) => input.startsWith(prefix)),
);
const required = [
  'packages/tui/src/auth/application.ts',
  'packages/tui/src/runtime/auth-session.ts',
  'packages/tui/src/runtime/mcode-tools-integration.ts',
  'packages/tui/src/account/matrix-account-client.ts',
  'packages/tui/src/checkin/http-gateway.ts',
  'packages/tui/src/runtime/feedback/service.ts',
  'packages/tui/src/update/application.ts',
  'packages/local-runtime-v2/src/service/plugin-system/plugin/runtime/registry-client.ts',
  'packages/local-runtime-v2/src/service/plugin-system/app/cloud-client.ts',
  'packages/local-runtime-v2/src/service/model-system/catalog/provider-presets/provider-presets.client.ts',
  'packages/local-runtime/src/web-search/local-web-search-client.ts',
  'packages/agent-modules/permission/src/http-cloud-gateway-client.ts',
];
const emitted = new Set(Object.values(metafile.outputs).flatMap(output =>
  Object.entries(output.inputs).filter(([, input]) => input.bytesInOutput > 0).map(([name]) => name)));
const missing = required.filter(input => !emitted.has(input));
if (missing.length) throw new Error(`Required TUI capabilities are absent from the built code:\n${missing.join('\n')}`);
if (violations.length)
  throw new Error(
    `Private host implementation reached the CLI build:\n${violations.join("\n")}`,
  );
console.log("Standalone build dependency boundary passed.");
