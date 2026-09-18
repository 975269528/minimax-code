import type { Api } from '@earendil-works/pi-ai';

import type { CapturedPayload } from './contracts.js';

const DEFAULT_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_OBSERVED_EVENT_BYTES = 64 * 1024 * 1024;

type JsonObject = Record<string, unknown>;

export interface ProviderResponseAssembler {
  observe(event: unknown): void;
  snapshot(): CapturedPayload;
}

/** Reassembles one provider-native response without retaining the event stream. */
export function createProviderResponseAssembler(
  apiId: Api | string,
  maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES,
): ProviderResponseAssembler {
  let observedBytes = 0;
  let failed = false;
  let omitted = false;
  let state: unknown;

  const fold = responseFolder(apiId);
  if (!fold) failed = true;

  return {
    observe(event) {
      if (failed || omitted || !fold) return;
      try {
        const serialized = JSON.stringify(event);
        if (serialized === undefined) throw new Error('provider event is not JSON');
        observedBytes += Buffer.byteLength(serialized, 'utf8');
        if (observedBytes > DEFAULT_MAX_OBSERVED_EVENT_BYTES) {
          omitted = true;
          state = undefined;
          return;
        }
        state = fold(state, JSON.parse(serialized) as unknown);
      } catch {
        failed = true;
        state = undefined;
      }
    },
    snapshot() {
      if (omitted) return { state: 'OMITTED_TOO_LARGE' };
      if (failed || state === undefined) return { state: 'CAPTURE_FAILED' };
      try {
        const json = JSON.stringify(responseSnapshot(apiId, state));
        if (json === undefined) return { state: 'CAPTURE_FAILED' };
        const byteLength = Buffer.byteLength(json, 'utf8');
        return byteLength > maxPayloadBytes
          ? { state: 'OMITTED_TOO_LARGE', byteLength }
          : { state: 'AVAILABLE', json, byteLength };
      } catch {
        return { state: 'CAPTURE_FAILED' };
      }
    },
  };
}

function responseSnapshot(apiId: string, state: unknown): unknown {
  if (apiId === 'anthropic-messages' && isMessagesAssembly(state)) return state.message;
  if (apiId === 'openai-completions' && isCompletionAssembly(state)) {
    return finalizeCompletionResponse(state.response);
  }
  if (
    (apiId === 'openai-responses' || apiId === 'openai-codex-responses') &&
    isResponsesAssembly(state)
  ) {
    return state.response;
  }
  return state;
}

function finalizeCompletionResponse(response: JsonObject): JsonObject {
  return {
    ...response,
    choices: (Array.isArray(response.choices) ? response.choices : []).map((rawChoice) => {
      if (!isObject(rawChoice)) return rawChoice;
      const message = isObject(rawChoice.message) ? rawChoice.message : {};
      return {
        ...rawChoice,
        message: {
          ...message,
          content: message.content ?? null,
          refusal: message.refusal ?? null,
        },
      };
    }),
  };
}

type ResponseFolder = (state: unknown, event: unknown) => unknown;

function responseFolder(apiId: string): ResponseFolder | undefined {
  switch (apiId) {
    case 'anthropic-messages':
      return foldMessagesEvent;
    case 'openai-completions':
      return foldOpenAICompletionChunk;
    case 'openai-responses':
    case 'openai-codex-responses':
      return foldOpenAIResponseEvent;
    default:
      return undefined;
  }
}

interface MessagesAssembly {
  message: JsonObject;
  blocks: Map<number, JsonObject>;
  partialInputs: Map<number, string>;
}

function foldMessagesEvent(rawState: unknown, rawEvent: unknown): unknown {
  if (!isObject(rawEvent) || typeof rawEvent.type !== 'string') return rawState;
  const state = asMessagesAssembly(rawState);
  applyMessagesEvent(state, rawEvent);
  syncMessagesContent(state);
  return state;
}

function applyMessagesEvent(state: MessagesAssembly, event: JsonObject): void {
  switch (event.type) {
    case 'message_start':
      startMessagesResponse(state, event.message);
      break;
    case 'content_block_start':
      startMessagesContentBlock(state, event);
      break;
    case 'content_block_delta':
      applyMessagesContentDelta(state, event);
      break;
    case 'content_block_stop':
      stopMessagesContentBlock(state, event.index);
      break;
    case 'message_delta':
      applyMessagesResponseDelta(state, event);
      break;
    default:
      break;
  }
}

function startMessagesResponse(state: MessagesAssembly, rawMessage: unknown): void {
  if (!isObject(rawMessage)) return;
  const content = Array.isArray(rawMessage.content) ? rawMessage.content : [];
  state.message = { ...rawMessage, content: [...content] };
  state.blocks.clear();
  state.partialInputs.clear();
  for (const [blockIndex, block] of content.entries()) {
    if (isObject(block)) state.blocks.set(blockIndex, { ...block });
  }
}

function startMessagesContentBlock(state: MessagesAssembly, event: JsonObject): void {
  const index = integer(event.index);
  if (index === undefined) return;
  const block = isObject(event.content_block) ? { ...event.content_block } : {};
  state.blocks.set(index, block);
  if (block.type === 'tool_use') {
    state.partialInputs.set(index, stringifyInitialToolInput(block.input));
  }
}

function applyMessagesContentDelta(state: MessagesAssembly, event: JsonObject): void {
  const index = integer(event.index);
  if (index === undefined) return;
  const block = state.blocks.get(index) ?? {};
  const delta = isObject(event.delta) ? event.delta : {};
  if (delta.type === 'text_delta') appendString(block, 'text', delta.text);
  else if (delta.type === 'thinking_delta') appendString(block, 'thinking', delta.thinking);
  else if (delta.type === 'signature_delta') appendString(block, 'signature', delta.signature);
  else if (delta.type === 'input_json_delta') applyMessagesToolInput(state, block, index, delta);
  else if (delta.type === 'citations_delta') appendMessagesCitation(block, delta.citation);
  state.blocks.set(index, block);
}

function applyMessagesToolInput(
  state: MessagesAssembly,
  block: JsonObject,
  index: number,
  delta: JsonObject,
): void {
  if (typeof delta.partial_json !== 'string') return;
  const partial = `${state.partialInputs.get(index) ?? ''}${delta.partial_json}`;
  state.partialInputs.set(index, partial);
  block.input = parsePartialJson(partial);
}

function appendMessagesCitation(block: JsonObject, citation: unknown): void {
  if (citation === undefined) return;
  const citations = Array.isArray(block.citations) ? [...block.citations] : [];
  citations.push(citation);
  block.citations = citations;
}

function stopMessagesContentBlock(state: MessagesAssembly, rawIndex: unknown): void {
  const index = integer(rawIndex);
  if (index === undefined) return;
  const block = state.blocks.get(index);
  const partial = state.partialInputs.get(index);
  if (block && partial !== undefined) block.input = parsePartialJson(partial);
}

function applyMessagesResponseDelta(state: MessagesAssembly, event: JsonObject): void {
  if (isObject(event.delta)) Object.assign(state.message, event.delta);
  if (!isObject(event.usage)) return;
  state.message.usage = {
    ...(isObject(state.message.usage) ? state.message.usage : {}),
    ...event.usage,
  };
}

function syncMessagesContent(state: MessagesAssembly): void {
  state.message.content = [...state.blocks.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, block]) => block);
}

function asMessagesAssembly(value: unknown): MessagesAssembly {
  if (isMessagesAssembly(value)) return value;
  return { message: {}, blocks: new Map(), partialInputs: new Map() };
}

function isMessagesAssembly(value: unknown): value is MessagesAssembly {
  return (
    isObject(value) &&
    value.message instanceof Object &&
    value.blocks instanceof Map &&
    value.partialInputs instanceof Map
  );
}

interface CompletionAssembly {
  response: JsonObject;
  choices: Map<number, JsonObject>;
}

function foldOpenAICompletionChunk(rawState: unknown, rawEvent: unknown): unknown {
  if (!isObject(rawEvent)) return rawState;
  const state = asCompletionAssembly(rawState);
  mergeCompletionResponseMetadata(state.response, rawEvent);
  for (const rawChoice of Array.isArray(rawEvent.choices) ? rawEvent.choices : []) {
    foldCompletionChoice(state, rawChoice);
  }
  syncCompletionChoices(state);
  return state;
}

function mergeCompletionResponseMetadata(response: JsonObject, event: JsonObject): void {
  for (const [key, value] of Object.entries(event)) {
    if (key !== 'choices') response[key] = value;
  }
  if (response.object === 'chat.completion.chunk') response.object = 'chat.completion';
}

function foldCompletionChoice(state: CompletionAssembly, rawChoice: unknown): void {
  if (!isObject(rawChoice)) return;
  const index = integer(rawChoice.index) ?? 0;
  const choice = state.choices.get(index) ?? { index, message: {}, logprobs: null };
  const message = isObject(choice.message) ? choice.message : {};
  mergeCompletionChoiceMetadata(choice, rawChoice);
  mergeCompletionLogprobs(choice, rawChoice.logprobs);
  mergeCompletionDelta(message, rawChoice.delta);
  choice.message = message;
  state.choices.set(index, choice);
}

function mergeCompletionChoiceMetadata(choice: JsonObject, rawChoice: JsonObject): void {
  for (const [key, value] of Object.entries(rawChoice)) {
    if (key !== 'delta' && key !== 'logprobs') choice[key] = value;
  }
}

function mergeCompletionDelta(message: JsonObject, rawDelta: unknown): void {
  const delta = isObject(rawDelta) ? rawDelta : {};
  if (typeof delta.role === 'string') message.role = delta.role;
  appendString(message, 'content', delta.content);
  appendString(message, 'refusal', delta.refusal);
  for (const key of ['reasoning_content', 'reasoning', 'reasoning_text']) {
    appendString(message, key, delta[key]);
  }
  foldLegacyFunctionCall(message, delta.function_call);
  foldCompletionToolCalls(message, delta.tool_calls);
  for (const [key, value] of Object.entries(delta)) {
    if (!COMPLETION_DELTA_KEYS.has(key)) message[key] = value;
  }
}

function syncCompletionChoices(state: CompletionAssembly): void {
  state.response.choices = [...state.choices.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, choice]) => choice);
}

const COMPLETION_DELTA_KEYS = new Set([
  'role',
  'content',
  'refusal',
  'reasoning_content',
  'reasoning',
  'reasoning_text',
  'function_call',
  'tool_calls',
]);

function mergeCompletionLogprobs(choice: JsonObject, rawLogprobs: unknown): void {
  if (!isObject(rawLogprobs)) {
    if (rawLogprobs === null && choice.logprobs === undefined) choice.logprobs = null;
    return;
  }
  const logprobs = isObject(choice.logprobs) ? choice.logprobs : {};
  for (const [key, value] of Object.entries(rawLogprobs)) {
    if ((key === 'content' || key === 'refusal') && Array.isArray(value)) {
      const accumulated = Array.isArray(logprobs[key]) ? [...logprobs[key]] : [];
      logprobs[key] = [...accumulated, ...value];
    } else {
      logprobs[key] = value;
    }
  }
  choice.logprobs = logprobs;
}

function foldLegacyFunctionCall(message: JsonObject, rawFunctionCall: unknown): void {
  if (!isObject(rawFunctionCall)) return;
  const fn = isObject(message.function_call) ? { ...message.function_call } : {};
  for (const [key, value] of Object.entries(rawFunctionCall)) {
    if (key === 'arguments') appendString(fn, key, value);
    else if (value !== undefined) fn[key] = value;
  }
  message.function_call = fn;
}

function asCompletionAssembly(value: unknown): CompletionAssembly {
  if (isCompletionAssembly(value)) return value;
  return { response: {}, choices: new Map() };
}

function isCompletionAssembly(value: unknown): value is CompletionAssembly {
  return isObject(value) && value.response instanceof Object && value.choices instanceof Map;
}

function foldCompletionToolCalls(message: JsonObject, rawCalls: unknown): void {
  if (!Array.isArray(rawCalls)) return;
  const calls = Array.isArray(message.tool_calls) ? [...message.tool_calls] : [];
  for (const rawCall of rawCalls) {
    mergeCompletionToolCall(calls, rawCall);
  }
  message.tool_calls = calls;
}

function mergeCompletionToolCall(calls: unknown[], rawCall: unknown): void {
  if (!isObject(rawCall)) return;
  const index = integer(rawCall.index) ?? calls.length;
  const call = isObject(calls[index]) ? { ...calls[index] } : {};
  if (rawCall.id !== undefined) call.id = rawCall.id;
  if (rawCall.type !== undefined) call.type = rawCall.type;
  mergeCompletionToolFunction(call, rawCall.function);
  for (const [key, value] of Object.entries(rawCall)) {
    if (!COMPLETION_TOOL_CALL_KEYS.has(key)) call[key] = value;
  }
  calls[index] = call;
}

const COMPLETION_TOOL_CALL_KEYS = new Set(['index', 'id', 'type', 'function']);

function mergeCompletionToolFunction(call: JsonObject, rawFunction: unknown): void {
  if (!isObject(rawFunction)) return;
  const fn = isObject(call.function) ? { ...call.function } : {};
  for (const [key, value] of Object.entries(rawFunction)) {
    if (key === 'arguments') appendString(fn, key, value);
    else if (value !== undefined) fn[key] = value;
  }
  call.function = fn;
}

interface ResponsesAssembly {
  response: JsonObject;
  output: Map<number, JsonObject>;
}

type ResponsesEventHandler = (state: ResponsesAssembly, event: JsonObject) => void;

const RESPONSES_EVENT_HANDLERS: Readonly<Record<string, ResponsesEventHandler>> = {
  'response.created': handleResponseCreated,
  'response.output_item.added': handleResponseOutputItem,
  'response.output_item.done': handleResponseOutputItem,
  'response.content_part.added': handleResponseContentPart,
  'response.content_part.done': handleResponseContentPart,
  'response.output_text.delta': handleResponseOutputTextDelta,
  'response.output_text.done': handleResponseOutputTextDone,
  'response.output_text.annotation.added': handleResponseOutputTextAnnotation,
  'response.refusal.delta': handleResponseRefusalDelta,
  'response.refusal.done': handleResponseRefusalDone,
  'response.function_call_arguments.delta': handleResponseFunctionArgumentsDelta,
  'response.function_call_arguments.done': handleResponseFunctionArgumentsDone,
  'response.reasoning_summary_part.added': handleResponseReasoningSummaryPart,
  'response.reasoning_summary_part.done': handleResponseReasoningSummaryPart,
  'response.reasoning_summary_text.delta': handleResponseReasoningSummaryTextDelta,
  'response.reasoning_summary_text.done': handleResponseReasoningSummaryTextDone,
  'response.reasoning_text.delta': handleResponseReasoningTextDelta,
  'response.reasoning_text.done': handleResponseReasoningTextDone,
  'response.completed': handleTerminalResponse,
  'response.incomplete': handleTerminalResponse,
  'response.failed': handleTerminalResponse,
};

function foldOpenAIResponseEvent(rawState: unknown, rawEvent: unknown): unknown {
  if (!isObject(rawEvent) || typeof rawEvent.type !== 'string') return rawState;
  const state = asResponsesAssembly(rawState);
  RESPONSES_EVENT_HANDLERS[rawEvent.type]?.(state, rawEvent);
  syncResponseOutput(state);
  return state;
}

function handleResponseCreated(state: ResponsesAssembly, event: JsonObject): void {
  if (!isObject(event.response)) return;
  state.response = { ...event.response };
  seedResponseOutput(state, event.response.output);
}

function handleResponseOutputItem(state: ResponsesAssembly, event: JsonObject): void {
  const index = integer(event.output_index) ?? state.output.size;
  if (isObject(event.item)) state.output.set(index, { ...event.item });
}

function handleResponseContentPart(state: ResponsesAssembly, event: JsonObject): void {
  const item = responseOutputItem(state, event.output_index);
  const content = Array.isArray(item.content) ? [...item.content] : [];
  const contentIndex = integer(event.content_index) ?? content.length;
  if (isObject(event.part)) content[contentIndex] = { ...event.part };
  item.content = content;
}

function handleResponseOutputTextDelta(state: ResponsesAssembly, event: JsonObject): void {
  appendString(responseContentPart(state, event, 'output_text'), 'text', event.delta);
}

function handleResponseOutputTextDone(state: ResponsesAssembly, event: JsonObject): void {
  if (typeof event.text === 'string') {
    responseContentPart(state, event, 'output_text').text = event.text;
  }
}

function handleResponseRefusalDelta(state: ResponsesAssembly, event: JsonObject): void {
  appendString(responseContentPart(state, event, 'refusal'), 'refusal', event.delta);
}

function handleResponseRefusalDone(state: ResponsesAssembly, event: JsonObject): void {
  if (typeof event.refusal === 'string') {
    responseContentPart(state, event, 'refusal').refusal = event.refusal;
  }
}

function handleResponseFunctionArgumentsDelta(state: ResponsesAssembly, event: JsonObject): void {
  appendString(responseOutputItem(state, event.output_index), 'arguments', event.delta);
}

function handleResponseFunctionArgumentsDone(state: ResponsesAssembly, event: JsonObject): void {
  if (typeof event.arguments === 'string') {
    responseOutputItem(state, event.output_index).arguments = event.arguments;
  }
}

function handleResponseReasoningSummaryPart(state: ResponsesAssembly, event: JsonObject): void {
  const item = responseOutputItem(state, event.output_index);
  const summary = Array.isArray(item.summary) ? [...item.summary] : [];
  const summaryIndex = integer(event.summary_index) ?? summary.length;
  if (isObject(event.part)) summary[summaryIndex] = { ...event.part };
  item.summary = summary;
}

function handleResponseReasoningSummaryTextDelta(
  state: ResponsesAssembly,
  event: JsonObject,
): void {
  const { item, summary, summaryIndex, part } = responseSummaryPart(state, event, true);
  appendString(part, 'text', event.delta);
  summary[summaryIndex] = part;
  item.summary = summary;
}

function handleResponseReasoningSummaryTextDone(state: ResponsesAssembly, event: JsonObject): void {
  if (typeof event.text !== 'string') return;
  const { item, summary, summaryIndex, part } = responseSummaryPart(state, event, false);
  part.text = event.text;
  summary[summaryIndex] = part;
  item.summary = summary;
}

function responseSummaryPart(
  state: ResponsesAssembly,
  event: JsonObject,
  includeEmptyText: boolean,
): {
  readonly item: JsonObject;
  readonly summary: unknown[];
  readonly summaryIndex: number;
  readonly part: JsonObject;
} {
  const item = responseOutputItem(state, event.output_index);
  const summary = Array.isArray(item.summary) ? [...item.summary] : [];
  const summaryIndex = integer(event.summary_index) ?? 0;
  const part = isObject(summary[summaryIndex])
    ? { ...summary[summaryIndex] }
    : { type: 'summary_text', ...(includeEmptyText ? { text: '' } : {}) };
  return { item, summary, summaryIndex, part };
}

function handleResponseReasoningTextDelta(state: ResponsesAssembly, event: JsonObject): void {
  appendString(responseContentPart(state, event, 'reasoning_text'), 'text', event.delta);
}

function handleResponseReasoningTextDone(state: ResponsesAssembly, event: JsonObject): void {
  if (typeof event.text === 'string') {
    responseContentPart(state, event, 'reasoning_text').text = event.text;
  }
}

function handleResponseOutputTextAnnotation(state: ResponsesAssembly, event: JsonObject): void {
  const part = responseContentPart(state, event, 'output_text');
  const annotations = Array.isArray(part.annotations) ? [...part.annotations] : [];
  const annotationIndex = integer(event.annotation_index) ?? annotations.length;
  annotations[annotationIndex] = event.annotation;
  part.annotations = annotations;
}

function handleTerminalResponse(state: ResponsesAssembly, event: JsonObject): void {
  if (!isObject(event.response)) return;
  const terminal = { ...state.response, ...event.response };
  const terminalOutput = Array.isArray(terminal.output) ? terminal.output : [];
  if (terminalOutput.length > 0) seedResponseOutput(state, terminalOutput);
  state.response = terminal;
}

function syncResponseOutput(state: ResponsesAssembly): void {
  const output = [...state.output.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, item]) => item);
  if (
    output.length > 0 &&
    (!Array.isArray(state.response.output) || state.response.output.length === 0)
  ) {
    state.response.output = output;
  }
}

function asResponsesAssembly(value: unknown): ResponsesAssembly {
  if (isResponsesAssembly(value)) return value;
  return { response: {}, output: new Map() };
}

function isResponsesAssembly(value: unknown): value is ResponsesAssembly {
  return isObject(value) && value.response instanceof Object && value.output instanceof Map;
}

function seedResponseOutput(state: ResponsesAssembly, value: unknown): void {
  if (!Array.isArray(value)) return;
  for (const [index, item] of value.entries()) {
    if (isObject(item)) state.output.set(index, { ...item });
  }
}

function responseOutputItem(state: ResponsesAssembly, rawIndex: unknown): JsonObject {
  const index = integer(rawIndex) ?? 0;
  const item = state.output.get(index) ?? {};
  state.output.set(index, item);
  return item;
}

function responseContentPart(
  state: ResponsesAssembly,
  event: JsonObject,
  type: 'output_text' | 'refusal' | 'reasoning_text',
): JsonObject {
  const item = responseOutputItem(state, event.output_index);
  const content = Array.isArray(item.content) ? [...item.content] : [];
  const index = integer(event.content_index) ?? 0;
  const part = isObject(content[index]) ? { ...content[index] } : { type };
  content[index] = part;
  item.content = content;
  return part;
}

function appendString(target: JsonObject, key: string, value: unknown): void {
  if (typeof value === 'string') target[key] = `${string(target[key])}${value}`;
}

function stringifyInitialToolInput(value: unknown): string {
  if (!isObject(value) || Object.keys(value).length === 0) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function parsePartialJson(value: string): unknown {
  if (value.length === 0) return {};
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function integer(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
