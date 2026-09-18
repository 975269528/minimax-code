// Retired host implementation, declared once and enforced by two different checks.
//
// The two checks have different domains and must not be collapsed into one list:
// `check:source` inspects the files that exist in this repository, while
// `check:standalone` inspects the input graph of the produced bundle. A path
// therefore belongs to exactly one of the two sets below.

// Must not exist as public source at all. Enforced by `check:source`.
export const retiredSourceRoots = [
  "packages/agent-modules/team/",
  "packages/agent-modules/permission/src/confirmation-gateway-client.ts",
  "packages/tui/src/auth/identity.ts",
  "packages/local-runtime/src/messages/queue-serialization.ts",
  "packages/local-runtime/src/workspace-indexing/",
  "packages/local-runtime-v2/src/service/workspace/indexing.ts",
  "packages/local-runtime-v2/src/application/conversation/workspace-snapshot-gate.ts",
  "packages/agent-tools/src/desktop/local-workspace-semantic-search.ts",
  "packages/thrift-gen/",
  "packages/thrift-gen-client/",
  "packages/local-runtime/src/http/",
  "packages/local-runtime-v2/src/http/",
  "packages/protocol/src/generated/",
  "packages/local-runtime-v2/src/service/session-handoff/",
];

// May exist as public source, but must never be reachable from the standalone
// build. Enforced by `check:standalone`.
export const nonBundledSources = [
  "packages/local-runtime/src/services/cu/native.ts",
];

// Anything retired from the source tree must also stay out of the build graph, so
// the boundary check enforces both sets. Declaring the union here keeps a path
// that later becomes publishable from silently losing its bundle restriction.
export const retiredBuildInputs = [
  ...retiredSourceRoots,
  ...nonBundledSources,
];
