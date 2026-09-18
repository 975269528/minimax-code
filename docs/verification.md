# Verification records

## Public import preparation, 2026-09-18

The private preparation branch adds official CLI onboarding and preserves the existing public Desktop support entry points. At implementation revision `1670bafd684ebf8dbb03dd41330ac2b099ffaf23`, `pnpm verify` passed all 14 applicable gates on macOS arm64, Node.js 26.4.0 and pnpm 9.12.0, including 3,352 capability tests. The six affected platform-fixture files passed locally after correcting PowerShell command quoting, SQLite teardown order, native path expectations, missing synthetic Windows prompt layers, and a fixture process holding a disappearing working directory. These are test-fixture repairs, not changes to runtime behavior.

The source preparation also tests public issue-form routing and offline Feishu payload generation; no notification was sent. Active documentation links use production sites, and all six CLI documentation links returned HTTP 200. Local Markdown file targets resolved successfully. History and built-distribution Gitleaks scans completed without unaddressed findings under the reviewed configuration; the exported source received a separate scan.

Subsequent Windows CI runs identified fixture teardown races: completed Bash tasks could still schedule database reads after the test closed SQLite. The fixture now closes delivery scheduling and drains background work before closing the database and removing files. The shared Vitest runner resolves Windows temporary directories to their canonical paths to avoid the [libuv short-path watcher assertion](https://github.com/libuv/libuv/issues/5010), with a subprocess regression covering its environment, arguments and exit status. The built image-preview artifact test now requires both a valid PNG reply and a clean Worker exit; it no longer immediately force-terminates the successful Worker. An earlier Node 22 native crash did not recur in the next unchanged-artifact run, so that observation alone is not treated as proof of its cause. The single Chinese documentation entry is `README_ZH.md`.

A local import rehearsal starts from public destination revision `cd025375799a1360d499d5c06cfb2e1111a960fc`, copies only authenticated archive files, and creates one new commit on that public base. The first comparison exposed Git newline normalization in 14 vendored Office XML schemas. The preparation now marks those schema assets as non-normalizing in `.gitattributes` and includes a staging regression for CRLF bytes. Rehearsal acceptance requires the imported Git tree to equal the reviewed source tree exactly, and the new reachable commit count to equal one. This local branch must not be pushed as part of private preparation.

Final cross-platform and source-candidate results belong to the private preparation PR's final head; local passes do not establish Windows/Linux acceptance. Existing main runs were blocked before startup by billing, while later dependency-PR runs executed and exposed the Windows fixture failures above. Check current run annotations rather than carrying the older billing diagnosis forward. Fresh managed login, real model requests, interactive Windows/Linux use and official installer replacement were not performed in this preparation. Publication authorization, an independent human review and destination administrative settings remain separate release-owner steps.

## Dependency security and unused implementation cleanup, 2026-09-18

The standalone workspace pins Vitest and its coverage package to 4.1.11, Vite to 7.3.6, Hono to 4.13.5, and Ajv's fast-uri to 3.1.6 through root overrides. The runtime uses smol-toml 1.7.1. Central overrides also cover vendored workspace development dependencies without rewriting upstream manifests. The suite launcher resolves the executable from Vitest's package manifest because the newer package no longer exports its CLI as a module subpath.

The TOML import regression runs the actual AgentImportService in a bounded child process: valid input succeeds, while comments ending unterminated arrays or inline tables are rejected. A subprocess timeout prevents a synchronous parser regression from hanging the test runner.

The unused Team cycle engine and two unreferenced adapters are removed. Legacy queue, lock and run-location modules retain the compatibility types required by shared adapters; their unused implementations are removed in place. The source inventory, package paths, lockfile and declared dependency licenses are regenerated. This change does not claim live-service acceptance or publication authorization.

## Current source verification status

The current source target is TUI **0.4.12**, with the separate versions described in [Preparation status](open-source-status.md#version-and-evidence-baseline). The 0.3.11 results below remain a historical record and have not been relabeled as current acceptance.

On 2026-09-12, source commit `edbd4bd483f9326fae14bed6852950f371d4feab` exported successfully without Git history: the source gate verified 4,090 files, workspace exports and native helper integrity; generated TypeScript paths matched 119 exports. These checks do not establish a complete build, test or live-service pass.

The Source verification and Release audit workflow runs for that commit failed before their jobs started. GitHub reported failed account payments or a spending-limit issue. Platform verification and the candidate job were skipped; no candidate artifact was generated for that run. This is an infrastructure block, not evidence of a code-test failure.

Current TUI 0.4.12 live-service acceptance, fresh login/logout, cross-platform interactive acceptance and a validated three-platform source candidate remain **NOT RUN / unavailable**. Add subsequent results with their revision, environment and scope instead of replacing the historical record.

### Source synchronization verification, 2026-09-18

The reviewed shared-source baseline is `9b9885e42a3cf1a3df1cfa52a46e4fdb034cfcee` (TUI 0.4.12). The standalone projection preserves its process-local protocol and public service configuration. Desktop HTTP/generated transports, cloud handoff, private packaging, and unrelated desktop additions remain excluded.

`pnpm verify` passed all 14 gates on macOS arm64, Node.js 26.4.0 and pnpm 9.12.0: source inventory (4,210 files), generated paths (121 exports), source export, release tooling (13 tests), typecheck, build, standalone boundary, built artifacts (4 tests), capabilities (2,679 tests), status contract (9 tests), CLI/ACP smoke (7 tests), offline BYOK (1 test), permission policy (115 tests), and macOS sandbox (48 tests). The artifact checks start the packaged image-preview Worker, and the sandbox suite includes real `sandbox-exec` and Git probes.

The expanded regressions cover model effort, headless preparation cancellation and response usage, image previews, MCP naming and cancellation, background Bash, prompt/agent storage, provider discovery, and content-safety V2. Image-header fixtures are synthetic; production-request images are excluded. Secret scanning covers all Git refs, the exported source, and build artifacts; the test token uses an explicit short placeholder.

Windows/Linux execution, fresh managed-account login, real provider calls, and live content-safety V2 endpoints were not run locally. Offline BYOK fixtures do not establish live-model acceptance. This synchronization does not publish an npm release or change repository visibility.

### Release-preparation verification, 2026-09-12

`pnpm verify` was run on `3de31f0e365e635c52d661c0a14c9ee69e65f099` in an isolated worktree after a frozen-lockfile install, on macOS arm64 with Node.js 26.4.0 and pnpm 9.12.0.

| Gate | Result |
| --- | --- |
| Source inventory, workspace exports and native helper integrity | PASS: 4,096 reviewed files |
| Generated TypeScript paths | PASS: 119 exports |
| History-free source export | PASS |
| Release tooling | PASS: 13 tests |
| Full typecheck | FAIL: `packages/tui/src/cli/network-proxy.ts:134`, TS2724; installed Undici 8 exposes `Dispatcher.DispatchHandler`, while the source references `Dispatcher.DispatchHandlers` |
| Build, standalone checks, artifact/capability/status/smoke/BYOK/policy/sandbox tests | NOT RUN: the full verifier stopped at typecheck |

The failing source file and dependency lockfile are unchanged from the reviewed base `edbd4bd483f9326fae14bed6852950f371d4feab`. At that revision, the preparation changed release metadata, attribution and contributor documentation without repairing the runtime/dependency mismatch. The follow-up below resolves it. A documentation-profile pass must not be substituted for full current-source acceptance.

### Merge-review follow-up, 2026-09-12

Commit `67ad241fb201c618bdedfba5998f7a6fb6f1d0cf` updates the proxy dispatcher's handler annotation to `Dispatcher.DispatchHandler`, matching Undici 8's installed `dispatch` signature. It forwards the handler unchanged and changes no runtime behavior.

On that commit, `pnpm verify` **passed all 14 applicable gates** on macOS arm64, Node.js 26.4.0, pnpm 9.12.0: source checks, generated paths, history-free export, release tooling, typecheck, build, standalone checks, artifact/capability/status/smoke/BYOK/policy/sandbox tests. The capability suite passed 412 tests; the existing real macOS sandbox probes also passed. Local Gitleaks scans of complete Git history, the committed source snapshot and the built distribution reported no findings with the reviewed `.gitleaks.toml` rules.

This resolves the local typecheck failure recorded above. It does not establish Windows/Linux acceptance, successful GitHub Actions runs, a three-platform source candidate or fresh live-service acceptance. The GitHub billing/spending-limit block and publication/admin prerequisites remain separate from this local verification result.

## Historical TUI 0.3.11 acceptance

Verification date: 2026-09-11. Environment: macOS arm64, Node.js 26.4.0, pnpm 9.12.0. Capability baseline: TUI 0.3.11.

This record preserves the clean-directory baseline from managed-capability restoration and adds private release review evidence. Passing tests do not mean all online services have passed acceptance; live evidence appears below and in `release-audit.md`.

## Clean-directory acceptance

Final source was copied outside the repository without `.git`, `node_modules`, `dist`, or `.cache`. A new pnpm store and public npm only were used for a frozen-lockfile install. The build downloaded the pinned MCode package again and extracted mcode-tools without reusing development artifacts.

| Check | Result |
| --- | --- |
| Cold install from public npm | Passed, approximately 1 minute 15 seconds |
| Source inventory, internal references, workspace exports, native helper integrity | Passed, 3979 files at this baseline |
| TypeScript check of the complete entry point | Passed |
| Standalone build and dependency boundaries | Passed; key managed capabilities remained in the output |
| Login, leases, accounts, plugins, connectors, feedback, updates, ACP, Matrix configuration | 21 explicitly selected test files; 321 tests passed |
| Original mcode-tools archive / file hashes, tamper rejection, actual CLI startup | 3 passed |
| CLI, providers, SQLite, ACP initialization, internal-switch rejection, offline local plugins | 7 passed |
| BYOK, session resume, actual file tools, managed-model authentication gate | 1 passed |
| Existing permission facade | 115 passed |
| Vela status protocol | 9 passed |
| Sandbox, executable resolution, actual macOS file / Git probes | 48 passed |

**504 automated tests passed** in total, with relevant validation completed in both development and clean directories.

The BYOK test uses a local OpenAI-format protocol server to drive the actual runtime. It verifies authorization headers, resume history, and real file contents in subsequent model requests, while ensuring Token Plan model overrides still require login. It does not establish real provider quality or production availability.

After managed capabilities were restored, startup could request the model catalog and telemetry. Offline tests return local 503 responses for an explicit public-service allowlist, recording attempts without sending them. Unknown addresses and unexpected TCP connections still fail tests. This verifies some unavailable-service behavior; those failures are not counted as live-service successes.

## Real TUI inspection

A real PTY with an isolated data directory and the network guard confirmed:

- Welcome shows Token Plan as unauthenticated.
- `/provider` presents both MiniMax OAuth / Token Plan and API key options.
- `/login` opens a cancellable China / international region selector.
- `/plugins` shows a clear error for an injected 503. Successful loading and source switching have component / application coverage; this manual check did not connect successfully to the official marketplace.
- `/exit` exits normally and restores terminal state.

That offline PTY check did not open a browser or call a real model. Subsequent online acceptance with an existing account is recorded separately below.

## Private release preparation additions

- Three tests cover source synchronization candidates, preservation of public changes, conflicts, and unsafe-output rejection. A no-change comparison against the actual baseline reported zero changes.
- Full-history, source-snapshot, and build-artifact Gitleaks scans were added. GitHub `Release audit` passed; see `release-audit.md` for false-positive handling and case sanitization.
- Initial Windows CI exposed Git CRLF conversion affecting native helper hashes. `.gitattributes` now pins LF. Later fixes addressed POSIX temporary paths, mock install layouts, and cmd quoting in tests. The relevant 70 tests passed locally; use PR checks for final platform results.
- GitHub runs macOS / Windows / Linux × Node.js 22 / 24. Each includes frozen install, source checks, source export, build, boundaries, tool artifacts, the 321-case capability suite, status protocol, smoke, and BYOK. Type checking runs once in the Linux / Node.js 22 full profile; the other five jobs use the platform profile, omitting only that compiler gate. Windows skips one POSIX-only capability case. Permission facade tests run outside Windows; actual sandbox probes run on macOS. GitHub runner success is not an interactive user-path check on each physical platform.

## Live production-account acceptance

Using the user-authorized existing login and dedicated temporary workspaces, the following were confirmed:

- A Token Plan MiniMax-M3 session succeeded; resume recovered the previous marker.
- BYOK provider connectivity and a real model session succeeded.
- Events confirmed a successful actual `web_search` call. A separate response that returned a URL without calling the tool was not counted.
- The official plugin marketplace returned 54 available plugins.
- Real bash → mcode-tools → host-lease authentication succeeded. Connector discovery returned 13 tools with no provider failures.

Actual service responses, credentials, and local account paths were not committed. Only synthetic acceptance results are recorded; this does not claim business calls for every plugin or generation tool.

## Not yet verified

- Fresh browser login / logout, full membership quota and billing validation, paid media generation, website deployment, new third-party connector grants / business writes, and feedback / diagnostic uploads.
- Interactive TUI user paths on Windows and Linux; GitHub runner builds and tests are recorded separately.
- Actual update installation / upgrade; the development machine's global installation was not changed.
- Real task quality for each bundled skill, and Desktop features outside the original TUI's defaults.

This historical acceptance did not publish the GitHub source repository or an npm package. The official npm product has a separate release history; its currently verified version is listed in [Preparation status](open-source-status.md). TypeScript remains strict; `noUncheckedIndexedAccess` and `noImplicitOverride` retain the vendored libraries' existing compatibility settings.

## Windows timeout investigation, 2026-09-12

On commit `4e7582c`, the Windows / Node.js 22 BYOK fixture exceeded its 35-second child-process deadline; the other six CI checks passed. The original failure reported only `Timed out: exec`, without the command phase or captured output, so it does not establish whether execution or process shutdown stalled.

The fixture now records per-command duration, bounded stdout / stderr and execution progress on timeout, plus an opt-in unreferenced process-resource probe. It waits for child `close` before reading complete output, and force-terminates timed-out children before cleanup. The 35-second deadline, 90-second overall bound, default text output, and BYOK / resume / actual-file assertions remain. No runtime behavior or timeout was relaxed. Use the latest PR run for the result; a passing follow-up does not by itself explain the earlier timeout.
