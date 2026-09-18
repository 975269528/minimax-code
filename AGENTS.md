# Agent guide

This repository is the reviewed public projection of an internal monorepo, not an ordinary workspace. Every published file is listed in `release/public-source.json`, and upstream changes arrive through a three-way merge described in `docs/source-sync.md`. Moving or renaming files therefore has a cost that a normal repository does not have: it shows up as a conflict or an unreviewed new file at the next synchronization. Prefer changing content over changing layout.

## Layout

- `packages/` — first-party workspace packages. `packages/agent-modules/*` is a second level of packages, not a package itself.
- `third_party/` — vendored upstream packages (`pi-mono`, `sandbox-runtime`) with their own licenses. Their test suites are not part of this distribution's verification.
- `release/` — machine-read release contracts. `extraction.json` pins the source baseline and package scope, `public-source.json` is the file inventory, `dependency-licenses.json` records declared dependency licenses. Build, type-check, test resolution, and source checks all read from here.
- `docs/` — human-read documentation only.
- `scripts/` — build and verification tooling. Shared constants live in `scripts/lib/`; import them instead of repeating literal paths or lists.
- `test/` — repository-level tests and `vitest-suites.json`, the declaration of every Vitest file this distribution runs.

## Generated files

Do not edit these by hand; regenerate them and commit the result.

| File | Regenerate with | Checked by |
| --- | --- | --- |
| `release/public-source.json` | `node scripts/source-inventory.mjs --write` | `pnpm check:source` |
| `tsconfig.standalone.json` (the `paths` block) | `pnpm gen:tsconfig` | `pnpm check:tsconfig` |

Review what changed before regenerating the inventory: recording a file does not make it suitable for publication.

## Single sources of truth

| Concern | Declared in | Consumed by |
| --- | --- | --- |
| Package scope | `release/extraction.json` (`packageRoots`) | build, type-check paths, Vitest aliases, source check, source sync |
| Package export → source file | each package's `exports` via `scripts/lib/package-exports.mjs` | `tsconfig.standalone.json`, `vitest.oss.config.mjs` |
| Test files per gate | `test/vitest-suites.json` | `vitest.oss.config.mjs`, `scripts/run-vitest-suite.mjs` |
| Retired source paths | `scripts/lib/retired-sources.mjs` | `check:source` (must not exist), `check:standalone` (must not be bundled) |
| Verification pipeline | `scripts/verify.mjs` | GitHub CI, `pnpm verify` |
| Documentation-only classification | `scripts/ci-changes.mjs` | source verification, release audit |
| Source archive validation/extraction | `scripts/lib/source-archive.mjs` | source export, candidate validation |

## Common changes

Adding a workspace package: add it to `pnpm-workspace.yaml` and to `packageRoots` in `release/extraction.json`, then run `pnpm gen:tsconfig` and `node scripts/source-inventory.mjs --write`.

Adding a test file: add its path to the appropriate group in `test/vitest-suites.json`. Do not add paths to `package.json` scripts or the Vitest config.

Adding a verification gate: add a step to `scripts/verify.mjs`, with `platforms` when it cannot run everywhere. Do not add steps to the workflow file.

## Verification

`pnpm verify` runs the same gates as CI in the same order; `pnpm verify --list` shows which apply on the current platform. Run it before opening a pull request. Individual gates such as `pnpm typecheck`, `pnpm build`, and `pnpm test:byok` remain available for iteration.

The full profile is the local default. `platform` omits only duplicate type checking; `docs` runs the source/export gates for documentation-only changes; `archive` validates an authenticated source candidate without attempting a Git export. Keep profile selection in the shared verifier. Add workflow safety and release-tool regressions to the existing `test/source-sync.test.mjs` suite.

## Boundaries

Do not reference internal hosts, generated IDL, or private services; `check:source` rejects them. Do not restore paths listed in `scripts/lib/retired-sources.mjs`. Do not commit account data, sessions, logs, or credentials. Documentation and commit messages are written in English; see `CONTRIBUTING.md`.
