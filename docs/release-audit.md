# Private release audit

This audit describes the historical TUI 0.3.11 baseline. The current source target is TUI 0.4.12; see [preparation status](open-source-status.md) and [current verification status](verification.md#current-source-verification-status). The earlier pass results are not current-release acceptance, and rights-holder authorization remains tracked separately in [Publication authorization](publication-authorization.md).

Date: 2026-09-11. Scope: standalone TUI 0.3.11 source, retained capabilities, dependency provenance, Git history, and local build artifacts. The user requested review and CI before publication. GitHub remains private; no release or npm package was published.

## Content and provenance

- Gitleaks 8.24.3 scanned complete Git history, a standalone source snapshot, and `dist`. The initial history scan found five items: a permission translation key, two keyboard shortcuts, a form field key, and an example pagination token. Each was verified as a non-credential. The build scan also found a node-forge function alias. `.gitleaks.toml` excludes these false positives only by specific file and full matched value, not entire test or skill directories. Repeat scans had no unaddressed findings. GitHub's `Release audit` runs all three scans.
- Manual review found a historical visa case with identity data in the PDF skill. Its original synthetic provenance could not be established. Current source uses explicitly synthetic people, documents, employers, and contact details while preserving AcroForm behavior, field structure, and workflow; internal case-origin labels were removed. Older private commits still contain the earlier version. Public distribution must therefore use a snapshot without history, not a visibility change on this review repository.
- The source gate checks internal addresses, generated protocols, environment files, the explicit inventory, workspace exports, and native helper hashes. The standalone gate checks actual build dependencies and key TUI capabilities. Scanning and review do not prove the absence of every unknown issue.
- `release/extraction.json` records the source baseline and 32 package roots: 27 declare Apache-2.0 and five MIT. Pi and Sandbox Runtime licenses, upstream revisions, and modification records remain. Assets retain their independent declarations.
- `release/dependency-licenses.json` records 503 dependency entries and 13 license expressions. Multiple-license expressions and additional declarations such as Zlib remain intact. This is a declaration inventory, not a complete license-text bundle for binary distribution.
- mcode-tools comes from pinned public `@minimax-ai/code@0.3.11`. The build verifies archive SHA-512 and embedded CLI SHA-256, retaining the 0.0.4 manifest and original distribution notices. The public package declares MIT; the root Apache-2.0 license does not relicense it. Rights-holder authorization to publish first-party source remains pending.

## Live-service evidence

The user authorized the existing production login on this machine. Sessions used dedicated temporary workspaces and synthetic inputs. Logs and account responses remain outside the repository and are not attached to public PRs.

| Path | Result |
| --- | --- |
| Existing OAuth / Token Plan → MiniMax-M3 | Actual request succeeded and returned the requested marker |
| Token Plan session resume | `--continue` successfully recovered the previous marker |
| BYOK connection and actual model session | Existing custom provider passed its connection test; a real session returned the requested marker |
| Built-in web_search | Events confirmed an actual tool call and successful search results; a request that only returned a known official URL was not counted as tool acceptance |
| Official plugin catalog | Live service returned 54 available plugins; this does not claim all plugins were installed or tested on real tasks |
| mcode-tools host lease | Real CLI launched through bash; `auth status` returned shared-broker authenticated |
| Connector tool discovery | `connector tools` returned 13 tools with `partial: false` and no provider failures; no third-party business writes were performed |

## Not run and publication boundaries

Browser login / logout was not repeated, to preserve the user's normal account state. Paid media generation, website deployment, diagnostic / feedback uploads, new third-party connector grants, and business writes were not performed. Not all bundled skills were tested on real tasks. Updates have test coverage, but the global installation on this machine was not replaced.

Use the PR checks for the final commit and cross-platform CI results. Offline tests, live-service evidence, and untested areas are recorded separately in `docs/verification.md`. Release documentation, source synchronization, and export tools are versioned. This audit does not grant publication authorization.

## Follow-up: root license attribution, 2026-09-12

The user identified a gap in the earlier audit: root `LICENSE` carried `Copyright 2025 Anthropic` and was byte-for-byte identical to `third_party/sandbox-runtime/LICENSE` (SHA-256 `1210bc93eb85dd786c33192d5bcb7153a93922fa99fbc1512af6a7199cb41080`). Git history confirmed these bytes were present in the first extraction commit, `2ca697f510ea1615280e47ade278fc60a330b28a`; the English translation did not introduce them. The previous audit did not establish correct first-party attribution.

The root file was replaced with the exact [standard Apache-2.0 text](https://www.apache.org/licenses/LICENSE-2.0.txt), SHA-256 `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`, including its unfilled example appendix. The source gate now checks this hash. All third-party license files and copyright notices remain unchanged. The first-party copyright holder and permission to publish remain unconfirmed; see `LICENSE-STATUS.md`.
