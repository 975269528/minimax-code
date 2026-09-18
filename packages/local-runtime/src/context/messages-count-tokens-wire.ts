export type CacheControlEphemeral = { type: 'ephemeral'; ttl?: '1h' };
export type MessagesTextBlock = {
  type: 'text';
  text: string;
  cache_control?: CacheControlEphemeral;
};
export type MessagesImageBlock = {
  type: 'image';
  source: {
    type: 'base64';
    media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
    data: string;
  };
  cache_control?: CacheControlEphemeral;
};
export type MessagesThinkingBlock = { type: 'thinking'; thinking: string; signature: string };
export type MessagesRedactedThinkingBlock = { type: 'redacted_thinking'; data: string };
export type MessagesToolUseBlock = {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
};
export type MessagesToolResultBlock = {
  type: 'tool_result';
  tool_use_id: string;
  content: string | Array<MessagesTextBlock | MessagesImageBlock>;
  is_error?: boolean;
  cache_control?: CacheControlEphemeral;
};
export type MessagesContentBlock =
  | MessagesTextBlock
  | MessagesImageBlock
  | MessagesThinkingBlock
  | MessagesRedactedThinkingBlock
  | MessagesToolUseBlock
  | MessagesToolResultBlock;
export type MessagesMessageParam = {
  role: 'user' | 'assistant';
  content: string | MessagesContentBlock[];
};
export type MessagesToolParam = {
  name: string;
  description?: string;
  eager_input_streaming?: boolean;
  input_schema: { type: 'object'; properties: unknown; required: string[] };
  cache_control?: CacheControlEphemeral;
};

export const NON_VISION_USER_IMAGE_PLACEHOLDER = '(image omitted: model does not support images)';
export const NON_VISION_TOOL_IMAGE_PLACEHOLDER =
  '(tool image omitted: model does not support images)';
export const PRIOR_THINKING_OPEN = '<|prior-thinking|>';
export const PRIOR_THINKING_CLOSE = '<|/prior-thinking|>';
export const SIBLING_NATIVE_THINKING_APIS = new Set<string>([
  'anthropic-messages',
  'bedrock-converse-stream',
]);
const REFERENCE_CLI_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'Bash',
  'Grep',
  'Glob',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'KillShell',
  'NotebookEdit',
  'Skill',
  'Task',
  'TaskOutput',
  'TodoWrite',
  'WebFetch',
  'WebSearch',
];
const REFERENCE_CLI_TOOL_LOOKUP = new Map(
  REFERENCE_CLI_TOOLS.map((name) => [name.toLowerCase(), name]),
);

export function isMessagesOAuthToken(apiKey: string): boolean {
  return apiKey.includes('sk-ant-oat');
}

export function toReferenceToolName(name: string): string {
  return REFERENCE_CLI_TOOL_LOOKUP.get(name.toLowerCase()) ?? name;
}

export function normalizeToolCallId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

export function sanitizeSurrogates(text: string): string {
  return text.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    '',
  );
}
