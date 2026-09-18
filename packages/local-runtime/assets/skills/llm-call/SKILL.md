---
name: llm-call
description: Call a configured LLM model directly through the local script using provider settings from config.yaml. Use this skill when the user wants a raw model call, prompt test, provider/model comparison, or asks to send text to a specific GPT/Gemini model. Do not use it for normal Mavis agent execution.
descriptions:
  zh-Hans: "直接调用配置好的 LLM 模型，用于原始模型调用、prompt 测试和 provider/model 对比。"
---

# LLM Call

Replace `<skill_dir>` with the actual skill path shown by the loader.

## Procedure

1. Read the user's target model and prompt.
2. **Always pass `--model provider/model`**. If the user didn't name a specific model, pick a sensible default or run `--list` first to check available models.
3. Pass `--system`, `--max-tokens`, `--temperature`, `--stream`, or `--config` only when the task clearly requires them.
4. The script auto-detects config.yaml from the parent data dir hint when available, falling back to `{{DATA_DIR}}/config.yaml`. Use `--config` when calling a non-default profile explicitly.
5. Return the model output directly. If the call fails, summarize the provider or config error without inventing a fallback.

## Protocol mapping

- `@ai-sdk/anthropic` -> `messages`
- `@ai-sdk/openai` -> `chat/completions`
- `@ai-sdk/google` -> `models/{model}:generateContent`

## Examples

The script is a plain `.py` file — pick the Python launcher that exists on the host:

| Platform | Launcher |
|---|---|
| macOS / Linux | `python3` (preferred) or `python` if it points at Python 3 |
| Windows | `py -3` (preferred) or `python` |

Example invocations (substitute the launcher above for `<py>`):

```bash
<py> <skill_dir>/scripts/llm_call.py --model gemini/gemini-2.5-pro --system "Be brief" --prompt "Summarize this"
<py> <skill_dir>/scripts/llm_call.py --model minimax-test/MiniMax-M3 --timeout 600 --stream --prompt "Long planning task"
<py> <skill_dir>/scripts/llm_call.py --list
```

Do not assume `python3` exists on Windows — it is not part of a default install. Use `py -3` or
the launcher resolved at runtime.

## Failure handling

- If config.yaml is missing or incomplete, say which provider or credential is missing.
- If the requested model is not configured, ask the user to choose from configured models.
- If the HTTP request fails, surface the provider error; do not silently retry with another model.
