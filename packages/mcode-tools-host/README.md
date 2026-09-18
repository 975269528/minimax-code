# @mavis/mcode-tools-host

Host-neutral Node.js lifecycle for an embedded `mcode-tools` artifact. The package validates the
versioned artifact, starts the local OAuth lease broker, installs profile-scoped launchers and owns
their cleanup.

The host remains the only credential-store, Refresh Token, refresh and logout owner. The host OAuth
Core persists credentials in its profile-scoped `auth.json`; this package and the embedded child
only receive short-lived Access Token leases. This package depends on `@mavis/oauth-lease-protocol`;
it must not depend on Electron, `@mavis/oauth-core` or a credential store.

Generated launchers clear inherited sandbox, API/auth URL, client and scope overrides before setting
the host-owned shared-broker coordinates. This keeps Desktop and TUI on the artifact's baked
business API profile while a lease is in use.

## 内置资源与系统代理

系统代理发现和 Node fetch 初始化由新版 mcode-tools CLI 自身承担。宿主只提供认证 Broker 和资源分发，
不注入代理地址，也不复制 CLI 的业务域名映射。

资源校验兼容旧 schema v3。schema v4 允许 CLI、registry-js 许可证和 Windows x64/arm64/ia32
预编译文件，校验完整资源集合、SHA-256 并拒绝符号链接。`resource-manifest.mjs` 同时供运行时、
Desktop/TUI 打包与产物验收使用；打包锁定 v4 manifest SHA-256，原生资源的锁定哈希也编入 CLI。
