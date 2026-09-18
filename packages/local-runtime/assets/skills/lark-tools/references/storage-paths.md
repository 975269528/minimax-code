# lark-tools Storage Paths

`lark-cli` stores its global config and encrypted credentials under a per-OS directory. Do not
assume the macOS path on other systems. The actual paths follow the standard OS "application support
/ data" convention, and `lark-cli` itself resolves them at runtime.

| Platform | Config                                | Encrypted appsecret / UAT                                                                                                                      |
| -------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS    | `~/.lark-cli/config.json`             | `~/Library/Application Support/lark-cli/appsecret_<appId>.enc` and `~/Library/Application Support/lark-cli/<appId>_<openId>.enc`               |
| Linux    | `~/.lark-cli/config.json`             | `${XDG_DATA_HOME:-$HOME/.local/share}/lark-cli/appsecret_<appId>.enc` and `${XDG_DATA_HOME:-$HOME/.local/share}/lark-cli/<appId>_<openId>.enc` |
| Windows  | `%USERPROFILE%\.lark-cli\config.json` | `%APPDATA%\lark-cli\appsecret_<appId>.enc` and `%APPDATA%\lark-cli\<appId>_<openId>.enc`                                                       |

Notes:

- `<appId>` and `<openId>` are filled in by `lark-cli` at write time; you should not generate these
  paths by hand.
- The encrypted UAT file is absent until the user has authorized at least once with
  `lark-cli auth login`.
- This skill never reads or writes these files directly; everything goes through `lark-cli`. The
  paths are documented here only so you can describe them accurately to the user when
  troubleshooting.
