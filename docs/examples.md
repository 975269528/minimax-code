# Examples

Build the project using the [installation guide](installation.md). Run the `pnpm mcode` commands below from the source root. For interactive tasks, open the target project directory and launch the built CLI by absolute path.

## 1. Edit code and run tests

`examples/clamp` is an intentionally broken exercise with one function and three Node.js tests. It needs no additional dependencies. Copy the directory to a temporary location, open that copy, and start:

```bash
node /absolute/path/to/minimax-code/dist/cli.js
```

Enter:

> Read clamp.mjs and clamp.test.mjs. Run node --test to reproduce the failure, fix clamp without changing the tests, then run the tests again.

In the [real demo](demo.md), two tests initially failed. After correcting the bounds, all three passed. Use `Ctrl+O` to inspect tool details. Choose permissions appropriate for your project; the demo ran in a temporary directory containing only synthetic files.

Resume the most recent session in the current directory:

```bash
node /absolute/path/to/minimax-code/dist/cli.js --continue
```

## 2. Choose your own model

Use `/provider` in the interactive TUI to select a configured model. Before adding a custom provider, set a key in your current shell rather than putting it in command arguments or source:

```bash
# POSIX shell: read the key interactively without echoing it.
read -s MCODE_PROVIDER_API_KEY
export MCODE_PROVIDER_API_KEY
```

In PowerShell, use a process environment variable and treat the input as sensitive:

```powershell
$secureKey = Read-Host 'API Key' -AsSecureString
$env:MCODE_PROVIDER_API_KEY = [System.Net.NetworkCredential]::new('', $secureKey).Password
```

Add, inspect, and test the provider:

```bash
pnpm mcode provider add --name my-provider --base-url https://example.com/v1 \
  --api-format openai-completions --model my-model \
  --api-key-env MCODE_PROVIDER_API_KEY --use
pnpm mcode provider list
pnpm mcode provider test <provider-id> --model <model-id>
pnpm mcode exec "Explain this project's test entry points" --model <provider-id>/<model-id>
```

Replace the example URL, model name, and IDs with your configuration and the IDs returned by the list command. `--use` sets the default model; `exec --model` overrides only the current run. Backslash line continuations are for POSIX shells; use a single line in PowerShell.

[Live acceptance](verification.md) separately verified MiniMax Token Plan and one configured BYOK provider. This is not a guarantee for every compatible service.

## 3. Search and image input

After signing in to MiniMax, try a task that explicitly requires search:

> Use web_search to find the official Node.js test runner documentation. Summarize how to run tests and include the source URL. If the tool is unavailable, say so.

Acceptance observed an actual `web_search` call and returned results; see the [verification record](verification.md). A model returning a URL alone does not prove it used search.

Paste your own image into the TUI, or attach a file explicitly:

```bash
pnpm mcode exec "Describe this UI screenshot's layout and suggest three improvements" \
  --file /absolute/path/to/your-screenshot.png
```

The image is sent as input to the selected model service. Use content suitable for sending and a model that supports images. This is an executable usage example, not a live-service acceptance result from this review. Search, image understanding, and media generation are separate capabilities; mcode-tools generation also requires the relevant account permissions and credits.

Use `/plugins` to manage extensions. See [capability coverage](tui-capabilities.md) for custom MCP, managed connectors, and media tools.
