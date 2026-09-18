# Standalone source preparation status

The current source target is **TUI 0.4.12**. Preserve its capabilities while retaining the public distribution boundary. The earlier BYOK-only extraction strategy is no longer the target.

## Version and evidence baseline

| Concern | Current value | Source of truth |
| --- | --- | --- |
| TUI capability version | 0.4.12 | `packages/tui/package.json` |
| Root workspace version | 0.4.12, aligned with the TUI | Root `package.json` |
| Published npm observation | `@minimax-ai/code@0.4.12`; npm `latest` was 0.4.12 on 2026-09-18 | Public npm registry |
| Shared-source baseline | `9b9885e42a3cf1a3df1cfa52a46e4fdb034cfcee` | `release/extraction.json` |
| Embedded mcode-tools | 0.0.4, extracted from public `@minimax-ai/code@0.3.11` | `scripts/lib/mcode-tools-artifact.mjs` |
| Historical live-service acceptance and demo | TUI 0.3.11, recorded 2026-09-11 | `docs/verification.md`, `docs/release-audit.md`, `docs/demo.md` |

The product, TUI and root workspace use the same 0.4.12 version. The embedded tool has its own version; its pinned archive is not the TUI source version. Workspace/local build manifests remain `private: true` to prevent accidental publication. The existing npm release is already available; matching version strings do not prove that this source tree reproduces that exact tarball. Earlier live-service acceptance remains historical evidence; it does not establish acceptance of TUI 0.4.12.

## Retained implementation

- MiniMax OAuth / Token Plan, account and quota views, check-in, the official plugin marketplace, managed connectors, search, mcode-tools, updates, feedback, and diagnostic clients are restored.
- The in-process runtime, public workspace dependencies, actual tools, and sandbox remain. Internal generated IDL, the Desktop HTTP front door, and cloud-executor-only implementations are not restored.
- mcode-tools is extracted from a pinned public npm package with archive and file hash verification. Only the host holds refresh tokens.
- Source scanning permits reviewed public service API paths while continuing to reject internal addresses, generated protocols, and obvious credentials. Build checks also verify that key capabilities remain present.
- Original internal history stays outside this repository and is not merged into public history.

See `tui-capabilities.md` for individual capabilities and `verification.md` for evidence. A private GitHub review repository and PR workflow are in place. The public npm registry was checked on 2026-09-18; that metadata check did not install the package, verify its runtime behavior, or publish source or packages. Historical TUI 0.3.11 Token Plan, BYOK, search, plugin catalog, and connector discovery checks have live evidence. Current-revision results and NOT RUN boundaries are tracked in `verification.md`. See `release-audit.md` for remaining limits; not every service or cross-platform interactive user path has been validated.


## Prepared public destination

The destination is `MiniMax-AI/minimax-code`. The private review tree now includes official CLI installation and first-task instructions, production documentation links, Desktop download/support entry points, the destination's established issue-form paths with product selection, a compatible Chinese README entry, and its support notification workflow restricted to the public destination. The reviewed source inventory includes these files. See [import preparation evidence](verification.md#public-import-preparation-2026-09-18) and [the import procedure](releasing.md#import-into-the-existing-public-repository).

The 0.4.12 candidate deliberately excludes open dependency-upgrade PRs; each upgrade needs separate review and validation. The source boundary, retained licenses and private-history exclusion remain unchanged. Registry metadata, local tests, CI, live-service acceptance and publication authorization are distinct evidence categories.
