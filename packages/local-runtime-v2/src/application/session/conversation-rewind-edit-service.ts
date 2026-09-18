import { createHash } from 'node:crypto';

import type {
  AgentHostInputAttachment,
  ConversationEditAdmissionInput,
  HistoryRewindInput,
  HistoryRewindResult,
  TurnDiffRewindOutcome,
  TurnService,
} from '../../service/turn-system/index.js';
import type { SessionRewindCapability } from '../../service/session-system/index.js';
import {
  CONVERSATION_MUTATION_NOT_SUPPORTED,
  CONVERSATION_MUTATION_REQUEST_CONFLICT,
  EDIT_RESTART_NEEDS_NEW_OPERATION,
  EDIT_RESTART_NEEDS_RESUBMIT,
  EDIT_SUBMIT_FAILED_AFTER_REWIND,
  HISTORY_CHAIN_CORRUPT,
  MESSAGE_BOUNDARY_INVALID,
  REWIND_DISPLAY_COMMIT_FAILED,
  TURN_ABORT_TIMEOUT,
  type ConversationMutationErrorCode,
} from './conversation-mutation-errors.js';

type RewindEditKind = 'session-rewind' | 'session-edit';
type RewindEditStage =
  | 'requested'
  | 'planned'
  | 'turn-published'
  | 'session-published'
  | 'questionnaire-published';

export interface RewindEditRequest {
  readonly sessionId: string;
  readonly userMessageId: string;
  readonly clientRequestId: string;
  readonly rewindTurnDiff?: boolean;
}

export interface EditRequest extends RewindEditRequest {
  readonly content: string;
  readonly attachments?: readonly AgentHostInputAttachment[];
}

export interface RewindResult {
  readonly rewoundMessageIds: readonly string[];
  readonly deletedMessageIds: readonly string[];
  readonly historyRevision: string;
  readonly displayRevision: number;
  readonly turnDiffRewind: TurnDiffRewindOutcome;
}

export interface EditResult extends RewindResult {
  readonly admitted: true;
  readonly turnId: string;
  readonly userMessageId: string;
}

export interface EditNeedsResubmitResult extends RewindResult {
  readonly rewound: true;
  readonly needsResubmit: true;
}

export interface RewindEditIntent {
  readonly schemaVersion: 2;
  readonly kind: RewindEditKind;
  readonly operationId: string;
  readonly sessionId: string;
  readonly userMessageId: string;
  readonly requestFingerprint: string;
  readonly rewindTurnDiff: boolean;
  readonly deletedDisplayMessageIds: readonly string[];
  readonly displayAffectedTurnIds: readonly string[];
  readonly displayOnlyBoundary?: HistoryRewindInput['displayOnlyBoundary'];
  readonly unresolvedQuestionnaireRequestIds?: readonly string[];
}

/** Compatibility for operation rows created by the pre-capability implementation on this branch. */
export interface LegacyRewindEditIntent {
  readonly schemaVersion: 1;
  readonly kind: RewindEditKind;
  readonly operationId: string;
  readonly sessionId: string;
  readonly userMessageId: string;
  readonly requestFingerprint: string;
  readonly targetRevision: string;
  readonly deletedMessageIds: readonly string[];
}

export interface RewindEditOperationRecord {
  readonly operationId: string;
  readonly sessionId: string;
  readonly kind: RewindEditKind;
  readonly status: string;
  readonly stage: string | null;
  readonly intent: RewindEditIntent | LegacyRewindEditIntent | undefined;
  readonly result: RewindResult | EditResult | EditNeedsResubmitResult | undefined;
  readonly error?: { readonly code: string; readonly message: string };
}

export interface RewindEditOperationPort {
  listPending(kind: RewindEditKind): Promise<readonly RewindEditOperationRecord[]>;
  read(input: {
    readonly operationId: string;
    readonly kind: RewindEditKind;
  }): Promise<RewindEditOperationRecord | undefined>;
  advance(input: {
    readonly operationId: string;
    readonly sessionId: string;
    readonly kind: RewindEditKind;
    readonly status: 'running';
    readonly stage: RewindEditStage;
    readonly intent: RewindEditIntent;
    readonly result?: RewindResult;
  }): Promise<RewindEditOperationRecord>;
  complete(input: {
    readonly operationId: string;
    readonly sessionId: string;
    readonly kind: RewindEditKind;
    readonly result: RewindResult | EditResult | EditNeedsResubmitResult;
  }): Promise<void>;
  fail(input: {
    readonly operationId: string;
    readonly sessionId: string;
    readonly kind: RewindEditKind;
    readonly stage: string;
    readonly intent?: RewindEditIntent | LegacyRewindEditIntent;
    readonly error: { readonly code: string; readonly message: string };
  }): Promise<void>;
}

interface RewindEditProjectionPort {
  project(input: {
    readonly sessionId: string;
    readonly operationId: string;
    readonly rewoundMessageIds: readonly string[];
    readonly deletedMessageIds: readonly string[];
  }): Promise<void>;
}

interface RewindEditEventPort {
  publish(input: {
    readonly sessionId: string;
    readonly operationId: string;
    readonly deletedMessageIds: readonly string[];
  }): Promise<void>;
}

interface RewindEditSubmitPort {
  submit(
    input: Omit<ConversationEditAdmissionInput, 'attachments'> & {
      readonly attachments: readonly AgentHostInputAttachment[];
    },
  ): Promise<{ readonly turnId: string; readonly userMessageId: string }>;
}

export interface RewindEditQuestionnairePort {
  snapshotUnresolvedForRewind(sessionId: string): Promise<readonly string[]>;
  cancelUnresolvedForRewind(input: {
    readonly sessionId: string;
    readonly requestIds: readonly string[];
  }): Promise<void>;
}

export interface RewindEditServiceDependencies {
  readonly operations?: RewindEditOperationPort;
  readonly turn?: Pick<TurnService, 'abort' | 'rewind'>;
  readonly session?: SessionRewindCapability;
  readonly projection?: RewindEditProjectionPort;
  readonly events?: RewindEditEventPort;
  readonly submit?: RewindEditSubmitPort;
  readonly questionnaires?: RewindEditQuestionnairePort;
}

export class RewindEditServiceError extends Error {
  constructor(
    readonly code: ConversationMutationErrorCode,
    message: string,
    readonly rewound = false,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'RewindEditServiceError';
  }
}

export class RewindEditService {
  constructor(private readonly deps: RewindEditServiceDependencies) {}

  async rewind(input: RewindEditRequest): Promise<RewindResult> {
    this.validate(input);
    const result = await this.execute(input, 'session-rewind');
    if (isEditResult(result) || isNeedsResubmit(result)) incompleteMutation();
    return result;
  }

  async edit(input: EditRequest): Promise<EditResult> {
    this.validate(input);
    if (!input.content.trim()) {
      throw new RewindEditServiceError(MESSAGE_BOUNDARY_INVALID, 'content must not be empty');
    }
    const result = await this.execute(input, 'session-edit');
    if (isNeedsResubmit(result)) {
      throw new RewindEditServiceError(
        EDIT_RESTART_NEEDS_RESUBMIT,
        'History was rewound before restart; submit the preserved draft as a new message',
        true,
      );
    }
    if (!isEditResult(result)) incompleteMutation();
    return result;
  }

  /** Recovery leaves post-canonical publication failures blocked for an idempotent retry. */
  async recoverPending(): Promise<void> {
    const ports = this.requirePorts('session-edit');
    for (const kind of ['session-rewind', 'session-edit'] as const) {
      const records = await ports.operations.listPending(kind);
      for (const record of records) {
        await this.recoverRecord(ports, record);
      }
    }
  }

  private async recoverRecord(ports: RequiredPorts, record: RewindEditOperationRecord) {
    try {
      const persisted = record.intent;
      if (persisted?.schemaVersion === 1) {
        await recoverLegacyOperation(ports, record, persisted);
        return;
      }
      const intent = requireIntent(record);
      if (
        record.kind === 'session-edit' &&
        (record.stage === 'requested' || record.stage === 'planned')
      ) {
        throw new RewindEditServiceError(
          EDIT_RESTART_NEEDS_NEW_OPERATION,
          'Restarted Edit has no request body to resume; start a new request',
        );
      }
      await this.resume({
        input: {
          sessionId: intent.sessionId,
          userMessageId: intent.userMessageId,
          clientRequestId: intent.operationId,
          ...(intent.rewindTurnDiff ? { rewindTurnDiff: true } : {}),
        },
        kind: record.kind,
        fingerprint: intent.requestFingerprint,
        record,
        ports,
        recoverOnly: true,
      });
    } catch (error) {
      if (isRetryableSessionPublication(error)) return;
      await terminalizeRecoveryFailure(ports.operations, record, error, {
        operationId: record.operationId,
        sessionId: record.sessionId,
        kind: record.kind,
      });
    }
  }

  private async execute(
    input: RewindEditRequest | EditRequest,
    kind: RewindEditKind,
  ): Promise<RewindResult | EditResult | EditNeedsResubmitResult> {
    const ports = this.requirePorts(kind);
    const fingerprint = requestFingerprint(input, kind);
    const previous = await ports.operations.read({
      operationId: input.clientRequestId,
      kind,
    });
    if (previous?.status === 'completed' && previous.result) {
      assertMatchingTarget(previous, input);
      return previous.result;
    }
    if (previous?.status === 'failed') {
      assertMatchingTarget(previous, input);
      if (previous.error?.code === EDIT_RESTART_NEEDS_NEW_OPERATION) {
        throw new RewindEditServiceError(EDIT_RESTART_NEEDS_NEW_OPERATION, previous.error.message);
      }
      throw new RewindEditServiceError(
        HISTORY_CHAIN_CORRUPT,
        previous.error?.message ??
          'This conversation mutation did not complete; start a new request',
      );
    }
    if (previous) assertMatchingIntent(previous, input, fingerprint);
    try {
      return await this.resume({ input, kind, fingerprint, record: previous, ports });
    } catch (error) {
      if (shouldTerminalizeMutation(error, kind)) {
        const current = await ports.operations.read({
          operationId: input.clientRequestId,
          kind,
        });
        await terminalizeRecoveryFailure(ports.operations, current ?? previous, error, {
          operationId: input.clientRequestId,
          sessionId: input.sessionId,
          kind,
        });
      }
      throw error;
    }
  }

  private async resume(input: ResumeMutationInput) {
    let record = input.record;
    if (!record) record = await createRequestedMutation(input);
    assertMatchingIntent(record, input.input, input.fingerprint);
    if (record.status === 'completed' && record.result) return record.result;
    record = await abortAndPlanMutation(input, record);
    record = await publishTurnMutation(input, record);
    record = await publishSessionMutation(input, record);
    const sessionResult = await publishQuestionnaireMutation(input, record);
    await publishBestEffort(input.ports, input.input, sessionResult);
    return finishMutation(input, sessionResult);
  }

  private validate(input: RewindEditRequest): void {
    if (
      !input.sessionId.trim() ||
      !input.clientRequestId.trim() ||
      !/^msg-user-v1-\S+$/u.test(input.userMessageId)
    ) {
      throw new RewindEditServiceError(
        MESSAGE_BOUNDARY_INVALID,
        'Rewind/Edit requires a committed msg-user-v1 user message',
      );
    }
  }

  private requirePorts(kind: RewindEditKind): RequiredPorts {
    const deps = this.deps;
    if (
      !deps.operations ||
      !deps.turn ||
      !deps.session ||
      !deps.questionnaires ||
      !deps.projection ||
      !deps.events ||
      (kind === 'session-edit' && !deps.submit)
    ) {
      throw new RewindEditServiceError(
        CONVERSATION_MUTATION_NOT_SUPPORTED,
        'Conversation mutation workflow is not supported',
      );
    }
    return deps as RequiredPorts;
  }
}

type RequiredPorts = Required<RewindEditServiceDependencies>;

interface ResumeMutationInput {
  readonly input: RewindEditRequest | EditRequest;
  readonly kind: RewindEditKind;
  readonly fingerprint: string;
  readonly record: RewindEditOperationRecord | undefined;
  readonly ports: RequiredPorts;
  readonly recoverOnly?: boolean;
}

async function createRequestedMutation(
  input: ResumeMutationInput,
): Promise<RewindEditOperationRecord> {
  const intent: RewindEditIntent = {
    schemaVersion: 2,
    kind: input.kind,
    operationId: input.input.clientRequestId,
    sessionId: input.input.sessionId,
    userMessageId: input.input.userMessageId,
    requestFingerprint: input.fingerprint,
    rewindTurnDiff: requestedTurnDiff(input.input),
    deletedDisplayMessageIds: [],
    displayAffectedTurnIds: [],
    unresolvedQuestionnaireRequestIds: [],
  };
  return input.ports.operations.advance({
    operationId: input.input.clientRequestId,
    sessionId: input.input.sessionId,
    kind: input.kind,
    status: 'running',
    stage: 'requested',
    intent,
  });
}

async function abortAndPlanMutation(
  input: ResumeMutationInput,
  record: RewindEditOperationRecord,
): Promise<RewindEditOperationRecord> {
  if (requireStage(record.stage) !== 'requested') return record;
  const abort = await input.ports.turn.abort({
    sessionId: input.input.sessionId,
    reason: 'conversation-mutation',
  });
  if (abort.status === 'abort-timeout') {
    throw new RewindEditServiceError(TURN_ABORT_TIMEOUT, 'Conversation abort timed out');
  }
  const display = await input.ports.session.planInclusive({
    sessionId: input.input.sessionId,
    fromMessageId: input.input.userMessageId,
  });
  if (
    display.targetIsQuestionnaireResponse &&
    (input.kind === 'session-edit' || !display.targetQuestionnaireResponseRewindEligible)
  ) {
    throw new RewindEditServiceError(
      MESSAGE_BOUNDARY_INVALID,
      'Questionnaire responses cannot be rewound or edited',
    );
  }
  const unresolvedQuestionnaireRequestIds =
    await input.ports.questionnaires.snapshotUnresolvedForRewind(input.input.sessionId);
  const intent = {
    ...requireIntent(record),
    deletedDisplayMessageIds: display.deletedMessageIds,
    displayAffectedTurnIds: display.affectedTurnIds,
    ...(display.targetTurnId
      ? {
          displayOnlyBoundary: {
            turnId: display.targetTurnId,
            subsequentUserMessageIds: [...(display.subsequentUserMessageIds ?? [])],
            affectedTurnIds: [...display.affectedTurnIds],
          },
        }
      : {}),
    unresolvedQuestionnaireRequestIds,
  };
  return input.ports.operations.advance({
    operationId: input.input.clientRequestId,
    sessionId: input.input.sessionId,
    kind: input.kind,
    status: 'running',
    stage: 'planned',
    intent,
  });
}

async function publishTurnMutation(
  input: ResumeMutationInput,
  record: RewindEditOperationRecord,
): Promise<RewindEditOperationRecord> {
  if (requireStage(record.stage) !== 'planned') return record;
  const intent = requireIntent(record);
  const turn = await input.ports.turn.rewind({
    sessionId: input.input.sessionId,
    fromUserMessageIdInclusive: input.input.userMessageId as `msg-user-v1-${string}`,
    operationId: input.input.clientRequestId,
    ...(intent.rewindTurnDiff ? { rewindTurnDiff: true } : {}),
    ...(intent.displayOnlyBoundary ? { displayOnlyBoundary: intent.displayOnlyBoundary } : {}),
  });
  const result = rewindResult(input.input.userMessageId, intent.deletedDisplayMessageIds, turn);
  return input.ports.operations.advance({
    operationId: input.input.clientRequestId,
    sessionId: input.input.sessionId,
    kind: input.kind,
    status: 'running',
    stage: 'turn-published',
    intent,
    result,
  });
}

async function publishSessionMutation(
  input: ResumeMutationInput,
  record: RewindEditOperationRecord,
): Promise<RewindEditOperationRecord> {
  const stage = requireStage(record.stage);
  if (stage === 'session-published' || stage === 'questionnaire-published') return record;
  const existing =
    record.result && isRewindResult(record.result) ? rewindOnly(record.result) : null;
  if (stage !== 'turn-published' || !existing) incompleteMutation();
  const intent = requireIntent(record);
  try {
    const display = await input.ports.session.commit({
      sessionId: input.input.sessionId,
      fromMessageId: input.input.userMessageId,
      expectedDeletedMessageIds: intent.deletedDisplayMessageIds,
      affectedTurnIds: turnAffectedIds(record.result) ?? intent.displayAffectedTurnIds,
    });
    const result = {
      ...existing,
      deletedMessageIds: display.deletedMessageIds,
      displayRevision: display.displayRevision,
    };
    return await input.ports.operations.advance({
      operationId: input.input.clientRequestId,
      sessionId: input.input.sessionId,
      kind: input.kind,
      status: 'running',
      stage: 'session-published',
      intent,
      result,
    });
  } catch (error) {
    throw new RewindEditServiceError(
      REWIND_DISPLAY_COMMIT_FAILED,
      'Canonical history was committed but Session projections are pending retry',
      true,
      { cause: error },
    );
  }
}

async function publishQuestionnaireMutation(
  input: ResumeMutationInput,
  record: RewindEditOperationRecord,
): Promise<RewindResult> {
  const stage = requireStage(record.stage);
  const existing =
    record.result && isRewindResult(record.result) ? rewindOnly(record.result) : undefined;
  if (stage === 'questionnaire-published' && existing) return existing;
  if (stage !== 'session-published' || !existing) incompleteMutation();
  const intent = requireIntent(record);
  try {
    const requestIds = intent.unresolvedQuestionnaireRequestIds ?? [];
    if (requestIds.length > 0) {
      await input.ports.questionnaires.cancelUnresolvedForRewind({
        sessionId: input.input.sessionId,
        requestIds,
      });
    }
    await input.ports.operations.advance({
      operationId: input.input.clientRequestId,
      sessionId: input.input.sessionId,
      kind: input.kind,
      status: 'running',
      stage: 'questionnaire-published',
      intent,
      result: existing,
    });
    return existing;
  } catch (error) {
    throw new RewindEditServiceError(
      REWIND_DISPLAY_COMMIT_FAILED,
      'Canonical history was committed but Session projections are pending retry',
      true,
      { cause: error },
    );
  }
}

function rewindResult(
  userMessageId: string,
  deletedMessageIds: readonly string[],
  turn: HistoryRewindResult,
): RewindResult & { readonly affectedTurnIds: readonly string[] } {
  return {
    rewoundMessageIds: [userMessageId],
    deletedMessageIds,
    historyRevision: turn.historyRevision,
    displayRevision: 0,
    turnDiffRewind: turn.turnDiffRewind,
    affectedTurnIds: turn.affectedTurnIds,
  };
}

async function finishMutation(
  input: ResumeMutationInput,
  result: RewindResult,
): Promise<RewindResult | EditResult | EditNeedsResubmitResult> {
  if (input.kind === 'session-rewind') {
    await completeMutation(input, result);
    return result;
  }
  if (input.recoverOnly) {
    const degraded: EditNeedsResubmitResult = {
      ...result,
      rewound: true,
      needsResubmit: true,
    };
    await completeMutation(input, degraded);
    return degraded;
  }
  return submitEditedTurn(input, result);
}

async function submitEditedTurn(
  input: ResumeMutationInput,
  rewind: RewindResult,
): Promise<EditResult> {
  const edit = requireEditRequest(input.input);
  try {
    const admitted = await input.ports.submit.submit({
      sessionId: edit.sessionId,
      operationId: edit.clientRequestId,
      content: edit.content,
      attachments: edit.attachments ?? [],
    });
    const result: EditResult = { ...rewind, admitted: true, ...admitted };
    await completeMutation(input, result);
    return result;
  } catch (error) {
    throw new RewindEditServiceError(
      EDIT_SUBMIT_FAILED_AFTER_REWIND,
      'Edit submission failed after rewind',
      true,
      { cause: error },
    );
  }
}

async function completeMutation(
  input: ResumeMutationInput,
  result: RewindResult | EditResult | EditNeedsResubmitResult,
): Promise<void> {
  await input.ports.operations.complete({
    operationId: input.input.clientRequestId,
    sessionId: input.input.sessionId,
    kind: input.kind,
    result,
  });
}

async function terminalizeRecoveryFailure(
  operations: RewindEditOperationPort,
  record: RewindEditOperationRecord | undefined,
  error: unknown,
  fallback?: {
    readonly operationId: string;
    readonly sessionId: string;
    readonly kind: RewindEditKind;
  },
): Promise<void> {
  const intent = record?.intent;
  const identity = intent
    ? { operationId: intent.operationId, sessionId: intent.sessionId, kind: intent.kind }
    : fallback;
  if (!identity) return;
  await operations.fail({
    ...identity,
    stage: record?.stage ?? 'recovery-failed',
    ...(intent ? { intent } : {}),
    error: {
      code:
        error instanceof RewindEditServiceError && error.code === EDIT_RESTART_NEEDS_NEW_OPERATION
          ? EDIT_RESTART_NEEDS_NEW_OPERATION
          : 'CONVERSATION_MUTATION_RECOVERY_FAILED',
      message:
        error instanceof Error
          ? error.message
          : 'Conversation mutation recovery failed; start a new request',
    },
  });
}

function requireEditRequest(input: RewindEditRequest | EditRequest): EditRequest {
  if ('content' in input) return input;
  incompleteMutation();
}

function requestFingerprint(input: RewindEditRequest | EditRequest, kind: RewindEditKind): string {
  const edit = kind === 'session-edit' ? (input as EditRequest) : undefined;
  return createHash('sha256')
    .update(
      stableJson({
        kind,
        sessionId: input.sessionId,
        userMessageId: input.userMessageId,
        rewindTurnDiff: requestedTurnDiff(input),
        ...(edit ? { content: edit.content, attachments: edit.attachments ?? [] } : {}),
      }),
    )
    .digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function requestedTurnDiff(input: RewindEditRequest | EditRequest): boolean {
  return input.rewindTurnDiff === true;
}

function assertMatchingIntent(
  record: RewindEditOperationRecord,
  input: RewindEditRequest,
  fingerprint: string,
): void {
  const intent = assertMatchingTarget(record, input);
  if (intent.schemaVersion !== 2) requestConflict();
  if (intent.requestFingerprint !== fingerprint) requestConflict();
}

function assertMatchingTarget(
  record: RewindEditOperationRecord,
  input: RewindEditRequest,
): RewindEditIntent | LegacyRewindEditIntent {
  const intent = record.intent;
  if (
    !intent ||
    intent.operationId !== input.clientRequestId ||
    intent.sessionId !== input.sessionId ||
    intent.userMessageId !== input.userMessageId ||
    intent.kind !== record.kind
  ) {
    requestConflict();
  }
  return intent;
}

function requestConflict(): never {
  throw new RewindEditServiceError(
    CONVERSATION_MUTATION_REQUEST_CONFLICT,
    'Operation ID was already used for a different mutation request',
  );
}

function requireIntent(record: RewindEditOperationRecord): RewindEditIntent {
  if (!record.intent || record.intent.schemaVersion !== 2) incompleteMutation();
  return record.intent;
}

async function recoverLegacyOperation(
  ports: RequiredPorts,
  record: RewindEditOperationRecord,
  intent: LegacyRewindEditIntent,
): Promise<void> {
  if (
    record.kind !== 'session-edit' ||
    (record.stage !== 'canonical-published' && record.stage !== 'display-published')
  ) {
    incompleteMutation();
  }
  const affectedTurnIds =
    record.stage === 'canonical-published'
      ? (
          await ports.session.planInclusive({
            sessionId: intent.sessionId,
            fromMessageId: intent.userMessageId,
          })
        ).affectedTurnIds
      : [];
  const display = await ports.session.commit({
    sessionId: intent.sessionId,
    fromMessageId: intent.userMessageId,
    expectedDeletedMessageIds: intent.deletedMessageIds,
    affectedTurnIds,
  });
  await ports.operations.complete({
    operationId: intent.operationId,
    sessionId: intent.sessionId,
    kind: intent.kind,
    result: {
      rewoundMessageIds: [intent.userMessageId],
      deletedMessageIds: display.deletedMessageIds,
      historyRevision: intent.targetRevision,
      displayRevision: display.displayRevision,
      turnDiffRewind: { status: 'not-requested' },
      rewound: true,
      needsResubmit: true,
    },
  });
}

function requireStage(stage: string | null): RewindEditStage {
  if (
    stage === 'requested' ||
    stage === 'planned' ||
    stage === 'turn-published' ||
    stage === 'session-published' ||
    stage === 'questionnaire-published'
  ) {
    return stage;
  }
  incompleteMutation();
}

function incompleteMutation(): never {
  throw new RewindEditServiceError(
    HISTORY_CHAIN_CORRUPT,
    'Conversation mutation state is incomplete',
  );
}

function isRewindResult(
  value: RewindResult | EditResult | EditNeedsResubmitResult,
): value is RewindResult {
  return (
    Array.isArray(value.rewoundMessageIds) &&
    Array.isArray(value.deletedMessageIds) &&
    typeof value.historyRevision === 'string' &&
    typeof value.displayRevision === 'number'
  );
}

function rewindOnly(value: RewindResult): RewindResult {
  return {
    rewoundMessageIds: value.rewoundMessageIds,
    deletedMessageIds: value.deletedMessageIds,
    historyRevision: value.historyRevision,
    displayRevision: value.displayRevision,
    turnDiffRewind: value.turnDiffRewind,
  };
}

function turnAffectedIds(value: unknown): readonly string[] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const affected = Reflect.get(value, 'affectedTurnIds');
  return Array.isArray(affected) && affected.every((entry) => typeof entry === 'string')
    ? affected
    : undefined;
}

function isEditResult(
  value: RewindResult | EditResult | EditNeedsResubmitResult,
): value is EditResult {
  return 'admitted' in value && value.admitted === true;
}

function isNeedsResubmit(
  value: RewindResult | EditResult | EditNeedsResubmitResult,
): value is EditNeedsResubmitResult {
  return 'needsResubmit' in value && value.needsResubmit === true;
}

function isRetryableEditSubmission(error: unknown, kind: RewindEditKind): boolean {
  return (
    kind === 'session-edit' &&
    error instanceof RewindEditServiceError &&
    error.code === EDIT_SUBMIT_FAILED_AFTER_REWIND
  );
}

function isRetryableSessionPublication(error: unknown): boolean {
  return (
    error instanceof RewindEditServiceError &&
    error.code === REWIND_DISPLAY_COMMIT_FAILED &&
    error.rewound
  );
}

function shouldTerminalizeMutation(error: unknown, kind: RewindEditKind): boolean {
  return !isRetryableEditSubmission(error, kind) && !isRetryableSessionPublication(error);
}

async function publishBestEffort(
  ports: RequiredPorts,
  input: RewindEditRequest,
  result: RewindResult,
): Promise<void> {
  await Promise.allSettled([
    ports.projection.project({
      sessionId: input.sessionId,
      operationId: input.clientRequestId,
      rewoundMessageIds: result.rewoundMessageIds,
      deletedMessageIds: result.deletedMessageIds,
    }),
    ports.events.publish({
      sessionId: input.sessionId,
      operationId: input.clientRequestId,
      deletedMessageIds: result.deletedMessageIds,
    }),
  ]);
}
