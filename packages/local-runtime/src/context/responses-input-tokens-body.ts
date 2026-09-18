import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Api, Context, Message, Model, Tool } from '@earendil-works/pi-ai';
import { convertResponsesMessages, convertResponsesTools } from '@earendil-works/pi-ai';
import { thinkingToPortableText, toProviderMessages } from './messages-count-tokens-messages.js';

export interface ResponsesInputTokensRequestBody {
  model: string;
  input: unknown;
  tools?: unknown[];
}

const OPENAI_RESPONSES_TOOL_CALL_PROVIDERS = new Set(['openai', 'openai-codex', 'opencode']);

export function buildResponsesInputTokensRequestBody(
  messages: AgentMessage[],
  systemPrompt: string | undefined,
  model: Model<Api>,
  tools?: Tool[],
): ResponsesInputTokensRequestBody {
  const context: Context = {
    systemPrompt,
    messages: normalizeResponsesThinking(toProviderMessages(messages, model)),
    tools,
  };
  const allowedToolCallProviders = new Set(OPENAI_RESPONSES_TOOL_CALL_PROVIDERS);
  if (model.provider) allowedToolCallProviders.add(model.provider);
  const body: ResponsesInputTokensRequestBody = {
    model: model.id,
    input: convertResponsesMessages(model, context, allowedToolCallProviders),
  };
  if (tools && tools.length > 0) {
    body.tools = convertResponsesTools(tools);
  }
  return body;
}

function normalizeResponsesThinking(messages: Message[]): Message[] {
  return messages.map((message) => {
    if (message.role !== 'assistant') return message;
    let changed = false;
    const content = message.content.flatMap((block) => {
      if (block.type !== 'thinking' || isResponsesReasoningSignature(block.thinkingSignature)) {
        return block;
      }
      changed = true;
      return thinkingToPortableText(block);
    });
    return changed ? { ...message, content } : message;
  });
}

function isResponsesReasoningSignature(signature: string | undefined): boolean {
  if (!signature) return false;
  try {
    const parsed = JSON.parse(signature) as unknown;
    return (
      parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      (parsed as { type?: unknown }).type === 'reasoning'
    );
  } catch {
    return false;
  }
}

export function responsesInputTokensBodyHasImages(body: ResponsesInputTokensRequestBody): boolean {
  return hasInputImage(body.input);
}

export function responsesInputTokensBodyHasVideo(body: ResponsesInputTokensRequestBody): boolean {
  return hasInputVideo(body.input);
}

function hasInputImage(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => hasInputImage(item));
  const record = value as Record<string, unknown>;
  if (record.type === 'input_image') return true;
  return Object.values(record).some((nested) => hasInputImage(nested));
}

function hasInputVideo(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => hasInputVideo(item));
  const record = value as Record<string, unknown>;
  if (
    record.type === 'input_image' &&
    typeof record.image_url === 'string' &&
    record.image_url.toLowerCase().startsWith('data:video/')
  ) {
    return true;
  }
  return Object.values(record).some((nested) => hasInputVideo(nested));
}
