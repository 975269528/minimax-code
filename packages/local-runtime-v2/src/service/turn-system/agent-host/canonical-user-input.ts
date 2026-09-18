import { normalizeModelSelection } from './preparation/config/model-selection-input.js';
import type {
  AgentHostCanonicalUserInput,
  AgentHostChannelContext,
  AgentHostInputAttachment,
  AgentHostInputOrigin,
  AgentHostQueuedUserInput,
  AgentHostExecutionRequest,
  AgentHostTurnProvenance,
  AgentHostUserInput,
  TurnOutputContract,
} from './preparation/contracts.js';
import { isInputSafetyDecision, type InputSafetyDecision } from '../../content-safety/index.js';
import { captureSemanticSnapshot } from './history/semantic-identity.js';

const USER_MESSAGE_ID_RE = /^msg-user-v1-[A-Za-z0-9_-]+$/u;

export class AgentHostUserInputValidationError extends TypeError {
  override readonly name = 'AgentHostUserInputValidationError';

  constructor(
    readonly reason:
      | 'invalid-text'
      | 'invalid-queue'
      | 'invalid-structure'
      | 'invalid-model'
      | 'invalid-request'
      | 'invalid-ingress'
      | 'invalid-provenance'
      | 'unsupported-field',
  ) {
    super(`AgentHost canonical user input is invalid: ${reason}.`);
  }
}

const MESSAGE_FIELDS = [
  'text',
  'attachments',
  'origin',
  'quotedMessage',
  'channelContext',
] as const;
const USER_INPUT_FIELDS = [...MESSAGE_FIELDS, 'queuedMessages', 'model'] as const;
const ATTACHMENT_FIELDS = [
  'type',
  'filePath',
  'fileName',
  'mimeType',
  'desktopPath',
  'dataUrl',
  'assetId',
  'error',
] as const;
const CHANNEL_CONTEXT_FIELDS = [
  'platform',
  'chatType',
  'chatId',
  'senderId',
  'clientName',
  'threadId',
  'sourceMessageId',
  'contextToken',
  'channel',
  'channel_id',
] as const;
const MODEL_PARAMETER_SNAPSHOT_FIELDS = ['context', 'effort'] as const;
const ORIGIN_FIELDS = ['kind', 'taskIds', 'observedTerminalCount'] as const;
const PROVENANCE_FIELDS = ['source', 'sourceContext', 'routingFingerprint'] as const;
const REQUEST_FIELDS = [
  'immediateSendBatch',
  'input',
  'outputContract',
  'executionDeadlineAtMs',
  'genuineUserQueryText',
  'inputSafetyDecision',
  'requiresInputReview',
  'clientRequestId',
  'userMessageId',
  'provenance',
  'queueItemIds',
  'clientIntent',
  'executionMode',
] as const;

/**
 * Establishes the one closed, detached public execution request accepted by
 * AgentHost. Validation and every downstream consumer use this same snapshot;
 * richer caller-owned subclasses or post-callback mutation cannot bypass the
 * contract.
 */
export function captureAgentHostExecutionRequest(
  request: AgentHostExecutionRequest,
): AgentHostExecutionRequest {
  if (!isRecord(request)) {
    throw new AgentHostUserInputValidationError('invalid-request');
  }
  assertOnlyFields(request, REQUEST_FIELDS);
  const snapshot = captureSemanticSnapshot<unknown>(request).value;
  if (!isRecord(snapshot)) {
    throw new AgentHostUserInputValidationError('invalid-request');
  }
  const immediateSendBatch = snapshotImmediateSendBatch(snapshot.immediateSendBatch);
  const queueItemIds = snapshotQueueItemIds(snapshot.queueItemIds);
  const input = snapshotUserInput(snapshot.input);
  const outputContract = snapshotOutputContract(snapshot.outputContract);
  const executionDeadline = snapshotExecutionDeadlineField(snapshot.executionDeadlineAtMs);
  const inputSafetyDecision = snapshotInputSafetyDecision(snapshot.inputSafetyDecision);
  const requiresInputReview = snapshotRequiresInputReview(snapshot.requiresInputReview);
  const provenance = snapshotProvenance(snapshot.provenance);
  const clientRequestId = optionalNonEmptyString(snapshot, 'clientRequestId', 'invalid-request');
  const genuineUserQueryText = snapshotGenuineUserQueryText(snapshot.genuineUserQueryText);
  const clientIntent = optionalNonEmptyString(snapshot, 'clientIntent', 'invalid-request');
  const executionMode = snapshotExecutionModeField(snapshot.executionMode);
  const userMessageId = snapshot.userMessageId;
  if (userMessageId !== undefined && !isAgentHostUserMessageId(userMessageId)) {
    invalidUserMessageId();
  }
  return captureSemanticSnapshot<AgentHostExecutionRequest>({
    input,
    immediateSendBatch,
    ...(outputContract ? { outputContract } : {}),
    ...executionDeadline,
    genuineUserQueryText,
    ...(inputSafetyDecision ? { inputSafetyDecision } : {}),
    ...(requiresInputReview !== undefined ? { requiresInputReview } : {}),
    provenance,
    ...clientRequestId,
    ...(userMessageId !== undefined ? { userMessageId } : {}),
    ...(queueItemIds ? { queueItemIds } : {}),
    ...clientIntent,
    ...executionMode,
  }).value;
}

function snapshotExecutionDeadlineField(
  value: unknown,
): Pick<AgentHostExecutionRequest, 'executionDeadlineAtMs'> {
  if (value === undefined) return {};
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new AgentHostUserInputValidationError('invalid-request');
  }
  return { executionDeadlineAtMs: value };
}

function snapshotImmediateSendBatch(
  value: unknown,
): AgentHostExecutionRequest['immediateSendBatch'] {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.id) ||
    !Array.isArray(value.members) ||
    value.members.length === 0
  ) {
    throw new AgentHostUserInputValidationError('invalid-request');
  }
  assertOnlyFields(value, ['id', 'members']);
  const identities = new Set<string>();
  const members = value.members.map((member) => {
    if (
      !isRecord(member) ||
      !isAgentHostUserMessageId(member.userMessageId) ||
      identities.has(member.userMessageId) ||
      !isNonEmptyString(member.messageKey) ||
      typeof member.createdAt !== 'number' ||
      !Number.isFinite(member.createdAt)
    ) {
      throw new AgentHostUserInputValidationError('invalid-request');
    }
    assertOnlyFields(member, [
      'input',
      'genuineUserQueryText',
      'userMessageId',
      'messageKey',
      'createdAt',
      'provenance',
    ]);
    identities.add(member.userMessageId);
    return {
      input: snapshotBatchMemberInput(member.input),
      genuineUserQueryText: snapshotGenuineUserQueryText(member.genuineUserQueryText),
      userMessageId: member.userMessageId,
      messageKey: member.messageKey,
      createdAt: member.createdAt,
      provenance: snapshotProvenance(member.provenance),
    };
  });
  return { id: value.id, members };
}

function snapshotBatchMemberInput(value: unknown): AgentHostQueuedUserInput {
  if (!isRecord(value)) throw new AgentHostUserInputValidationError('invalid-request');
  assertOnlyFields(value, MESSAGE_FIELDS);
  return snapshotMessage(value);
}

function snapshotExecutionModeField(
  value: unknown,
): Pick<AgentHostExecutionRequest, 'executionMode'> {
  const executionMode = snapshotExecutionMode(value);
  return executionMode ? { executionMode } : {};
}

function snapshotExecutionMode(value: unknown): AgentHostExecutionRequest['executionMode'] {
  if (value === undefined) return undefined;
  if (value !== 'continuation') {
    throw new AgentHostUserInputValidationError('invalid-request');
  }
  return value;
}

function snapshotGenuineUserQueryText(value: unknown): string {
  if (typeof value !== 'string') {
    throw new AgentHostUserInputValidationError('invalid-request');
  }
  return value;
}

/** Captures active steering facts without pretending they are a new execution request. */
export function captureAgentHostSteeringInput(input: {
  readonly input: AgentHostUserInput;
  readonly provenance: AgentHostTurnProvenance;
  readonly userMessageId?: AgentHostExecutionRequest['userMessageId'];
}): {
  readonly input: AgentHostUserInput;
  readonly provenance: AgentHostTurnProvenance;
  readonly userMessageId?: AgentHostExecutionRequest['userMessageId'];
} {
  if (!isRecord(input)) {
    throw new AgentHostUserInputValidationError('invalid-request');
  }
  assertOnlyFields(input, ['input', 'provenance', 'userMessageId']);
  if (input.userMessageId !== undefined && !isAgentHostUserMessageId(input.userMessageId)) {
    invalidUserMessageId();
  }
  return captureSemanticSnapshot({
    input: snapshotUserInput(input.input),
    provenance: snapshotProvenance(input.provenance),
    ...(input.userMessageId !== undefined ? { userMessageId: input.userMessageId } : {}),
  }).value;
}

function invalidUserMessageId(): never {
  throw new AgentHostUserInputValidationError('invalid-request');
}

function isAgentHostUserMessageId(value: unknown): value is `msg-user-v1-${string}` {
  return typeof value === 'string' && USER_MESSAGE_ID_RE.test(value);
}

function snapshotRequiresInputReview(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new AgentHostUserInputValidationError('invalid-request');
  }
  return value;
}

function snapshotInputSafetyDecision(value: unknown): InputSafetyDecision | undefined {
  if (value === undefined) return undefined;
  if (!isInputSafetyDecision(value)) {
    throw new AgentHostUserInputValidationError('invalid-request');
  }
  return { ...value };
}

/**
 * Renders the primary input and every admitted queued message once, in FIFO
 * order. AgentRuntime assembly and the local executor share this exact value.
 */
export function createCanonicalAgentHostUserInput(
  unsafeRequest: AgentHostExecutionRequest,
): AgentHostCanonicalUserInput {
  const request = captureAgentHostExecutionRequest(unsafeRequest);
  return createCanonicalUserInput(request);
}

/** Renders an active steering message without requiring a new-Turn query identity. */
export function createCanonicalAgentHostSteeringInput(input: {
  readonly input: AgentHostUserInput;
  readonly provenance: AgentHostTurnProvenance;
}): AgentHostCanonicalUserInput {
  return createCanonicalUserInput(captureAgentHostSteeringInput(input));
}

function createCanonicalUserInput(input: {
  readonly input: AgentHostUserInput;
  readonly provenance: AgentHostTurnProvenance;
}): AgentHostCanonicalUserInput {
  const messages = [snapshotMessage(input.input), ...(input.input.queuedMessages ?? [])];
  return captureSemanticSnapshot({
    text: renderCanonicalText(messages, input.provenance.source),
    messages,
  }).value;
}

function snapshotUserInput(value: unknown): AgentHostUserInput {
  if (!isRecord(value)) {
    throw new AgentHostUserInputValidationError('invalid-structure');
  }
  assertOnlyFields(value, USER_INPUT_FIELDS);
  const message = snapshotMessage(value);
  const queuedMessages = snapshotQueue(value.queuedMessages);
  const model = snapshotModel(value.model);
  return {
    ...message,
    ...(queuedMessages ? { queuedMessages } : {}),
    ...(model ? { model } : {}),
  };
}

function snapshotOutputContract(value: unknown): TurnOutputContract | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new AgentHostUserInputValidationError('invalid-request');
  }
  if (value.type === 'json_object') {
    assertOnlyFields(value, ['type']);
    return { type: 'json_object' };
  }
  assertOnlyFields(value, ['type', 'schema']);
  if (value.type !== 'json_schema' || !isRecord(value.schema)) {
    throw new AgentHostUserInputValidationError('invalid-request');
  }
  return { type: 'json_schema', schema: value.schema };
}

function snapshotQueue(value: unknown): readonly AgentHostQueuedUserInput[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new AgentHostUserInputValidationError('invalid-queue');
  }
  return value.map((message) => {
    if (!isRecord(message)) {
      throw new AgentHostUserInputValidationError('invalid-structure');
    }
    assertOnlyFields(message, MESSAGE_FIELDS);
    return snapshotMessage(message);
  });
}

function snapshotMessage(
  input: AgentHostQueuedUserInput | Readonly<Record<string, unknown>>,
): AgentHostQueuedUserInput {
  if (typeof input.text !== 'string') {
    throw new AgentHostUserInputValidationError('invalid-text');
  }
  const attachments = snapshotAttachments(input.attachments);
  const origin = snapshotOrigin(input.origin);
  const quotedMessage = snapshotQuotedMessage(input.quotedMessage);
  const channelContext = snapshotChannelContext(input.channelContext);
  return {
    text: input.text,
    ...(attachments ? { attachments } : {}),
    ...(origin ? { origin } : {}),
    ...(quotedMessage ? { quotedMessage } : {}),
    ...(channelContext ? { channelContext } : {}),
  };
}

function snapshotAttachments(value: unknown): readonly AgentHostInputAttachment[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new AgentHostUserInputValidationError('invalid-structure');
  }
  return value.map((attachment) => {
    if (!isRecord(attachment)) {
      throw new AgentHostUserInputValidationError('invalid-structure');
    }
    assertOnlyFields(attachment, ATTACHMENT_FIELDS);
    assertOptionalStringFields(attachment, ATTACHMENT_FIELDS, 'invalid-structure');
    return { ...attachment };
  });
}

function snapshotOrigin(value: unknown): AgentHostInputOrigin | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new AgentHostUserInputValidationError('invalid-structure');
  }
  assertOnlyFields(value, ORIGIN_FIELDS);
  const observedTerminalCount = value.observedTerminalCount;
  if (
    value.kind !== 'background-task-terminal' ||
    !Array.isArray(value.taskIds) ||
    value.taskIds.some((taskId) => !isNonEmptyString(taskId)) ||
    (observedTerminalCount !== undefined &&
      (!Number.isSafeInteger(observedTerminalCount) || Number(observedTerminalCount) < 0))
  ) {
    throw new AgentHostUserInputValidationError('invalid-structure');
  }
  return {
    kind: value.kind,
    taskIds: [...value.taskIds],
    ...(observedTerminalCount === undefined
      ? {}
      : { observedTerminalCount: Number(observedTerminalCount) }),
  };
}

function snapshotQuotedMessage(
  value: unknown,
): AgentHostQueuedUserInput['quotedMessage'] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new AgentHostUserInputValidationError('invalid-structure');
  }
  assertOnlyFields(value, ['text', 'senderName']);
  if (
    typeof value.text !== 'string' ||
    (value.senderName !== undefined && typeof value.senderName !== 'string')
  ) {
    throw new AgentHostUserInputValidationError('invalid-structure');
  }
  return {
    text: value.text,
    ...(value.senderName ? { senderName: value.senderName } : {}),
  };
}

function snapshotChannelContext(value: unknown): AgentHostChannelContext | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new AgentHostUserInputValidationError('invalid-structure');
  }
  assertOnlyFields(value, CHANNEL_CONTEXT_FIELDS);
  assertOptionalStringFields(value, CHANNEL_CONTEXT_FIELDS, 'invalid-structure');
  if (
    !isNonEmptyString(value.platform) ||
    !isNonEmptyString(value.chatId) ||
    !isNonEmptyString(value.senderId)
  ) {
    throw new AgentHostUserInputValidationError('invalid-structure');
  }
  return {
    platform: value.platform,
    chatId: value.chatId,
    senderId: value.senderId,
    ...optionalString(value, 'chatType'),
    ...optionalString(value, 'clientName'),
    ...optionalString(value, 'threadId'),
    ...optionalString(value, 'sourceMessageId'),
    ...optionalString(value, 'contextToken'),
    ...optionalString(value, 'channel'),
    ...optionalString(value, 'channel_id'),
  };
}

function snapshotModel(value: unknown): AgentHostUserInput['model'] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new AgentHostUserInputValidationError('invalid-model');
  }
  let selection;
  try {
    selection = normalizeModelSelection(value);
  } catch {
    throw new AgentHostUserInputValidationError('invalid-model');
  }
  return {
    ...selection,
    ...(value.parameterSnapshot !== undefined
      ? { parameterSnapshot: snapshotModelParameterSnapshot(value.parameterSnapshot) }
      : {}),
  };
}

function snapshotModelParameterSnapshot(
  value: unknown,
): NonNullable<NonNullable<AgentHostUserInput['model']>['parameterSnapshot']> {
  if (!isRecord(value)) {
    throw new AgentHostUserInputValidationError('invalid-model');
  }
  assertOnlyFields(value, MODEL_PARAMETER_SNAPSHOT_FIELDS);
  if (
    (value.context !== 'default' && value.context !== 'selection' && value.context !== 'legacy') ||
    (value.effort !== 'default' && value.effort !== 'selection' && value.effort !== 'legacy')
  ) {
    throw new AgentHostUserInputValidationError('invalid-model');
  }
  return { context: value.context, effort: value.effort };
}

function snapshotQueueItemIds(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((itemId) => !isNonEmptyString(itemId))
  ) {
    throw new AgentHostUserInputValidationError('invalid-ingress');
  }
  return [...value];
}

function snapshotProvenance(value: unknown): AgentHostTurnProvenance {
  if (!isRecord(value)) {
    throw new AgentHostUserInputValidationError('invalid-provenance');
  }
  assertOnlyFields(value, PROVENANCE_FIELDS);
  if (
    !isNonEmptyString(value.source) ||
    !isNonEmptyString(value.routingFingerprint) ||
    (value.sourceContext !== undefined && !isRecord(value.sourceContext))
  ) {
    throw new AgentHostUserInputValidationError('invalid-provenance');
  }
  return {
    source: value.source,
    routingFingerprint: value.routingFingerprint,
    ...(value.sourceContext ? { sourceContext: value.sourceContext } : {}),
  };
}

function optionalNonEmptyString(
  value: Readonly<Record<string, unknown>>,
  key: string,
  reason: AgentHostUserInputValidationError['reason'],
): Readonly<Record<string, string>> {
  const candidate = value[key];
  if (candidate === undefined) return {};
  if (!isNonEmptyString(candidate)) throw new AgentHostUserInputValidationError(reason);
  return { [key]: candidate };
}

function optionalString(
  value: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, string>> {
  const candidate = value[key];
  return typeof candidate === 'string' ? { [key]: candidate } : {};
}

function assertOptionalStringFields(
  value: Readonly<Record<string, unknown>>,
  fields: readonly string[],
  reason: AgentHostUserInputValidationError['reason'],
): void {
  if (fields.some((field) => value[field] !== undefined && typeof value[field] !== 'string')) {
    throw new AgentHostUserInputValidationError(reason);
  }
}

function assertOnlyFields(
  value: Readonly<Record<string, unknown>>,
  fields: readonly string[],
): void {
  const allowed = new Set(fields);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new AgentHostUserInputValidationError('unsupported-field');
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function renderCanonicalText(
  messages: readonly AgentHostQueuedUserInput[],
  source: string,
): string {
  const first = messages[0];
  if (!first) throw new AgentHostUserInputValidationError('invalid-text');
  if (messages.length === 1) return renderMessage(first, source);
  const rendered = messages.map((message, index) => {
    const label = index === 0 ? 'User message 1' : `Queued user message ${index + 1}`;
    return `${label}:\n${renderMessage(message, source)}`;
  });
  return [
    'The user sent these local queued messages as one ordered batch. Process them in order.',
    '',
    ...rendered,
  ].join('\n\n');
}

function renderMessage(message: AgentHostQueuedUserInput, source: string): string {
  const quoted = message.quotedMessage;
  const content = quoted?.text
    ? [
        quoted.senderName
          ? `[User replied to a message from ${quoted.senderName}]:`
          : '[User replied to a previous message]:',
        quoted.text
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n'),
        '',
        message.text,
      ].join('\n')
    : message.text;
  return source === 'cron' ? `[System CronTask]\n${content}` : content;
}
