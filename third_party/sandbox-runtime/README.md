# Sandbox Runtime

This directory contains the complete sandbox source used by MiniMax Code, based on the upstream version pinned in `upstream.json`. See `LICENSE` for its license.

Pinned version: `0.0.74-mcode.2`; source revision: `630552a32ab23abd42d988ba50c80ea8efa974af`. Runtime code is not downloaded from a private registry.

Retained extensions include SecurityServer control, independent unlink scopes, deny-first network allow-all behavior, a sanitized baseEnv per invocation, caller-provided temporary directories, and file protection even when the network proxy is disabled.

`src/` contains the TypeScript implementation; `vendor/*-src/` contains native helper source; `vendor/*/build.ts` supplies build entry points. Bundled platform helpers match this version's npm distribution and are copied during CLI builds. Updates require rebuilding and validating the relevant platforms.

Additional change in this repository: executable lookup uses the Node filesystem directly, avoiding Unix `which` and its one-second process-start timeout.

This CLI supports Node only. The Bun-specific fetch proxy branch was removed; Node HTTPS proxy behavior retains TLS verification. The CONNECT peek buffer is explicitly copied into a Node Buffer to match runtime types.
