# TUI usage telemetry

MCode's TUI usage telemetry is disabled by default. No business telemetry client is created and no business telemetry request is sent until the user opts in.

## Turn it on or off

Add this to the active profile's `config.yaml`, normally `~/.minimax-code/config.yaml`, then restart MCode:

```yaml
telemetry:
  enabled: true
```

Remove the setting or set it to `false` to turn reporting off. Either environment variable below also turns it off and takes precedence over the config file:

```sh
MCODE_DISABLE_TELEMETRY=1 mcode
DO_NOT_TRACK=1 mcode
```

Inspect the effective setting with `mcode telemetry status`. Run `mcode telemetry preview` to see a representative decoded request. Preview does not send a request. When telemetry is disabled, preview shows `request: null`.

## Data sent

The HTTP body is `application/x-www-form-urlencoded` with two fields:

| Field  | Value                                                       |
| ------ | ----------------------------------------------------------- |
| `data` | Base64-encoded JSON envelope described below                |
| `ext`  | `crc=<number>`, an integrity checksum of the encoded `data` |

The decoded JSON envelope contains:

| Field                            | Value                                         |
| -------------------------------- | --------------------------------------------- |
| `identities.$identity_cookie_id` | Fresh random ID for this event                |
| `distinct_id`                    | The same fresh random ID                      |
| `lib.$lib`                       | `js`                                          |
| `lib.$lib_method`                | `code`                                        |
| `lib.$lib_version`               | MCode version                                 |
| `properties`                     | Common and event-specific fields listed below |
| `type`                           | `track`                                       |
| `event`                          | Event name from the table below               |
| `time`                           | Unix timestamp in milliseconds                |

Every `properties` object includes:

| Field         | Value                                                        |
| ------------- | ------------------------------------------------------------ |
| `surface`     | `tui`                                                        |
| `os`          | Node.js platform name, such as `darwin`, `linux`, or `win32` |
| `region`      | `cn` or `en`                                                 |
| `build_env`   | `dev`, `test`, `staging`, or `prod`                          |
| `app_version` | MCode version                                                |

Event-specific fields are limited to:

- `tui_launch`: `launch_type` (`cold`, `hot`).
- `login_click`, `logout_click`: no extra fields.
- `login_result`: `source` (`agent_web`, `agent_desktop`, `openplatform`, `mcode_tui`, `mcode_cli`); `result_type` (`1` success, `2` failure); `fail_reason` (empty for success, `1` server, `2` network, `3` cancelled, `4` other, `5` OAuth/authorization); `login_type` (`google`, `mobile`, `wechat`, `apple`, `minimax_sso`, `minimax_oauth`).
- `btw_session_lifecycle`: `phase` (`opened`, `closed`); `duration_bucket` (`not_applicable`, `under_1m`, `1m_to_5m`, `5m_to_30m`, `over_30m`); `exit_reason` (empty, `ctrl_c`, `ctrl_d`, `navigation`, `replaced`).
- `chat_send`: `chat_type` (`chat`, `agent_team`, `claw`, `hermes`, `IM`); `is_first_message` (`0`, `1`); `is_attachment` (`text`, `attachment`).
- `slash_command_menu_view`, `at_command_menu_view`: `chat_type` (values above).
- `slash_command_click`: `chat_type`; `command_type` (`skill`, `new_chat`, `summarize`, `plan_mode`, `goal_mode`, `other`).
- `at_command_click`: `chat_type`; `command_type` (`plugins`, `goal_mode`, `plan_mode`, `file`, `directory`).

MCode does not send account IDs, device IDs, workspace paths or names, session IDs, model names, prompts, responses, filenames, command text, plugin names, or credentials through this channel. The receiver requires an identity-shaped envelope, so the client creates a fresh random event ID for each request. It is never persisted or reused and cannot link two events on its own. MCode does not add an account authorization header to these requests.

As with any network request, the receiving server can observe transport metadata such as the source IP address. The client does not add that value to the event payload. `mcode telemetry preview` displays the decoded envelope.

## Destinations

The destination depends on region and build environment:

- China production: `https://data.hailuoai.com/meerkat-reporter/api/report?project=MiniMaxAgent`
- Global production: `https://data.hailuo.ai/meerkat-reporter/api/report?project=MiniMaxAgent`
- China non-production: `https://bigdata-test.xingyeai.com/meerkat-reporter/api/report?project=MiniMaxAgent`
- Global non-production: `https://bigdata-test.talkie-ai.com/meerkat-reporter/api/report?project=MiniMaxAgent`

The client keeps pending events only in memory and does not write them to disk. This repository does not define or verify server-side retention. Keep telemetry disabled when that policy does not meet your requirements.

This page covers TUI usage telemetry. Login, model requests, update checks, user-submitted feedback, and bounded error diagnostics have separate network behavior described in [TUI capability coverage](tui-capabilities.md).
