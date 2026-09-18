import { isSameResolvedPath } from '@mavis/permission';
import { KeyedOperationLane } from '@mavis/shared/keyed-operation-lane';
import { translateRuntimeText, type RuntimeTranslationKey } from '@mavis/shared/runtime-i18n';
import { createInternalTurnId } from '@mavis/shared/turn-identity';

import type {
  CommittedQueueCapability,
  QueueItem,
  SessionInteractionModeCapability,
} from '../session-system/index.js';
import type { PlanDocumentPort } from '../session-system/sessions/support/plan-document.js';
import type {
  PlanApplication,
  PlanEntryPreparationResult,
  PlanImplementationReceipt,
  PlanLifecycleAdmissionFence,
} from './contracts.js';

const PLAN_SNAPSHOT_MAX_BYTES = 512 * 1024;
const APPROVED_PLAN_MARKDOWN_INSTRUCTION = `Implement the approved plan below.
Treat the Markdown after the "Approved plan:" line as the immutable plan snapshot for this implementation turn; it is authoritative.
Do not read the canonical Plan file and do not re-derive the plan from anywhere else.

If implementation reveals the plan is infeasible or materially wrong — a premise fails, a referenced component does not exist, or the work is fundamentally riskier than planned — stop and report the mismatch to the user instead of redesigning on your own.
Mechanical adjustments that keep the plan's decisions intact do not require stopping.

Approved plan:
`;
// Rolling upgrade: durable implementation Queue items enqueued by an earlier
// build carry the previous instruction text. Identity validation accepts them
// so an approved Plan crossing an upgrade window is reused instead of failing
// closed; their persisted content still executes as-is.
const LEGACY_APPROVED_PLAN_MARKDOWN_INSTRUCTIONS: readonly string[] = [
  `Implement the approved plan below.
Treat the Markdown after the marker as the immutable plan snapshot for this implementation Turn.
Do not read the Plan file and do not re-derive the plan from anywhere else; this snapshot is authoritative.

Approved plan:
`,
];

class PlanApplicationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'PlanApplicationError';
  }
}

interface PlanApplicationOptions {
  readonly platform?: NodeJS.Platform;
  readonly entryEnabled?: () => boolean;
  readonly agentEntryEnabled?: () => boolean;
  readonly modes: Pick<SessionInteractionModeCapability, 'get' | 'setPlan' | 'ensureDefault'>;
  readonly lifecycleFence: Pick<PlanLifecycleAdmissionFence, 'blocks'>;
  readonly pendingQuestionnaires: {
    hasAny(sessionId: string): Promise<boolean>;
  };
  readonly documents: Pick<
    PlanDocumentPort,
    'resolveAndEnsure' | 'prepareNewDraft' | 'readFrozenSnapshot'
  >;
  readonly questionnaires: {
    resolveLocale(): string;
    createService(): {
      beginOwned(input: {
        readonly sessionId: string;
        readonly mode: 'plan';
        readonly agentName?: string;
        readonly runId?: string;
        readonly messageId?: string;
        readonly callId?: string;
        readonly modePayload?: {
          readonly planReview?: { readonly markdown: string; readonly path: string };
        };
        readonly toolInput: {
          readonly title?: string;
          readonly steps: {
            readonly id?: string;
            readonly question: string;
            readonly description?: string;
            readonly options?: {
              readonly id?: string;
              readonly label: string;
              readonly description?: string;
            }[];
          }[];
        };
      }): Promise<{ readonly requestId: string }>;
    };
  };
  readonly queue: Pick<
    CommittedQueueCapability,
    'list' | 'requireMutableSession' | 'findByClientRequestId' | 'enqueue' | 'cancel'
  >;
  readonly receipts: {
    findReceipt(turnId: string): Promise<PlanImplementationReceipt | undefined>;
  };
}

interface ConversationMutationPlanStateBinding {
  readonly modes: Pick<SessionInteractionModeCapability, 'get'>;
  readonly lifecycleFence: Pick<PlanLifecycleAdmissionFence, 'blocks'>;
  readonly mutationState: {
    bindPlanStateReader(
      reader: (sessionId: string) => Promise<{
        readonly active: boolean;
        readonly interactionMode: 'default' | 'plan' | undefined;
        readonly lifecycleActive: boolean;
      }>,
    ): void;
  };
}

type PlanQuestionnaireInput = Parameters<
  ReturnType<PlanApplicationOptions['questionnaires']['createService']>['beginOwned']
>[0];

type PreparePlanEntry = (
  sessionId: string,
  options?: { readonly excludeRequestId?: string },
) => Promise<PlanEntryPreparationResult>;

interface ApprovedPlanSource {
  readonly markdown: string;
}

export function createPlanApplication(options: PlanApplicationOptions): PlanApplication {
  const preparePlanEntry = createPlanEntryPreparation(options);
  return {
    preparePlanEntry: (sessionId) => preparePlanEntry(sessionId),
    enterFromAgent: (input) => enterFromAgent(options, input),
    exitFromAgent: (input) => exitFromAgent(options, input),
    confirmEntry: (input) => confirmEntry(options, preparePlanEntry, input),
    keepDefault: (sessionId) => keepDefault(options, sessionId),
    approve: (input) => approvePlan(options, input),
  };
}

export function bindConversationMutationPlanState(
  input: ConversationMutationPlanStateBinding,
): void {
  input.mutationState.bindPlanStateReader(async (sessionId) => {
    const interactionMode = await input.modes.get(sessionId);
    const lifecycleActive = await input.lifecycleFence.blocks({ sessionId });
    return {
      active: interactionMode === 'plan' || lifecycleActive,
      interactionMode: interactionMode === 'plan' ? 'plan' : 'default',
      lifecycleActive,
    };
  });
}

function createPlanEntryPreparation(options: PlanApplicationOptions): PreparePlanEntry {
  const lanes = new KeyedOperationLane<string>();
  return async (sessionId, input = {}) => {
    if (options.entryEnabled?.() === false) {
      return { status: 'rejected', reason: 'plan-entry-disabled' };
    }
    const release = await lanes.acquire(sessionId);
    try {
      if (
        await options.lifecycleFence.blocks({
          sessionId,
          ...(input.excludeRequestId ? { excludeRequestId: input.excludeRequestId } : {}),
        })
      ) {
        release();
        return { status: 'rejected', reason: 'plan-lifecycle-active' };
      }
      if (await options.pendingQuestionnaires.hasAny(sessionId)) {
        release();
        return { status: 'rejected', reason: 'plan-questionnaire-active' };
      }
      const mode = await options.modes.get(sessionId);
      if (mode === 'plan') {
        const document = await options.documents.resolveAndEnsure(sessionId);
        return readyPreparation(document.canonicalPath, false, release);
      }
      if (mode !== 'default') {
        release();
        return { status: 'rejected', reason: 'plan-mode-conflict' };
      }
      const draft = await options.documents.prepareNewDraft(sessionId);
      return readyPreparation(draft.canonicalPath, true, release, {
        commit: draft.commit,
        restore: draft.restore,
        revertMode: async () => {
          const transition = await options.modes.ensureDefault(sessionId);
          if (transition !== 'updated' && transition !== 'already-default') {
            throw new PlanApplicationError(
              'PLAN_MODE_CONFLICT',
              `Cannot compensate failed Plan entry: ${transition}`,
            );
          }
        },
      });
    } catch (error) {
      release();
      throw error;
    }
  };
}

async function enterFromAgent(
  options: PlanApplicationOptions,
  input: Parameters<PlanApplication['enterFromAgent']>[0],
) {
  assertNotAborted(input.signal);
  assertAgentEntryEnabled(options);
  const mode = await options.modes.get(input.sessionId);
  if (mode === undefined) {
    throw new PlanApplicationError('PLAN_SESSION_NOT_FOUND', 'Session does not exist');
  }
  if (mode === 'plan') {
    throw new PlanApplicationError('PLAN_MODE_ALREADY_ACTIVE', 'Plan Mode is already active');
  }
  const result = await beginPlanQuestionnaire(options, {
    sessionId: input.sessionId,
    mode: 'plan',
    runId: input.turnId,
    ...(input.toolCallId ? { callId: input.toolCallId } : {}),
    toolInput: planEntryToolInput(options.questionnaires.resolveLocale()),
  });
  return { requestId: result.requestId };
}

function planEntryToolInput(locale: string): PlanQuestionnaireInput['toolInput'] {
  const t = (key: RuntimeTranslationKey): string => translateRuntimeText(locale, key);
  return {
    title: t('plan.entry.title'),
    steps: [
      {
        id: 'plan-enter',
        question: t('plan.entry.question'),
        options: [
          {
            id: 'confirm',
            label: t('plan.entry.confirm.label'),
            description: t('plan.entry.confirm.description'),
          },
          {
            id: 'decline',
            label: t('plan.entry.decline.label'),
            description: t('plan.entry.decline.description'),
          },
        ],
      },
    ],
  };
}

async function exitFromAgent(
  options: PlanApplicationOptions,
  input: Parameters<PlanApplication['exitFromAgent']>[0],
) {
  assertNotAborted(input.signal);
  const mode = await options.modes.get(input.sessionId);
  if (mode !== 'plan') {
    throw new PlanApplicationError(
      mode === undefined ? 'PLAN_SESSION_NOT_FOUND' : 'PLAN_MODE_NOT_ACTIVE',
      mode === undefined ? 'Session does not exist' : 'Plan Mode is not active',
    );
  }
  if ((await options.queue.list(input.sessionId)).length > 0) {
    throw new PlanApplicationError(
      'PLAN_QUEUE_NOT_DRAINED',
      'Queued work must drain before Plan review',
    );
  }
  const snapshot = await options.documents.readFrozenSnapshot(
    input.sessionId,
    PLAN_SNAPSHOT_MAX_BYTES,
  );
  const result = await beginPlanQuestionnaire(options, {
    sessionId: input.sessionId,
    mode: 'plan',
    runId: input.turnId,
    ...(input.assistantMessageId ? { messageId: input.assistantMessageId } : {}),
    ...(input.toolCallId ? { callId: input.toolCallId } : {}),
    modePayload: {
      planReview: {
        markdown: snapshot.markdown,
        path: snapshot.canonicalPath,
      },
    },
    toolInput: {
      title: 'Review implementation plan',
      steps: [
        {
          id: 'plan-review',
          question: 'Approve this plan and start implementation?',
          ...(snapshot.truncated
            ? {
                description:
                  'The Plan exceeded 512 KiB; this review contains a safely truncated snapshot.',
              }
            : {}),
          options: [
            {
              id: 'approve',
              label: 'Approve',
              description: 'Exit Plan Mode and start one implementation Turn.',
            },
          ],
        },
      ],
    },
  });
  return { requestId: result.requestId, planPath: snapshot.canonicalPath };
}

async function confirmEntry(
  options: PlanApplicationOptions,
  preparePlanEntry: PreparePlanEntry,
  input: Parameters<PlanApplication['confirmEntry']>[0],
): Promise<void> {
  assertAgentEntryEnabled(options);
  const preparation = await preparePlanEntry(input.sessionId, {
    excludeRequestId: input.requestId,
  });
  if (preparation.status === 'rejected') {
    throw new PlanApplicationError(
      rejectionCode(preparation.reason),
      `Plan entry was rejected: ${preparation.reason}`,
    );
  }
  let enteredPlan = false;
  try {
    const transition = await options.modes.setPlan(input.sessionId);
    if (transition !== 'updated' && transition !== 'already-plan') {
      throw new PlanApplicationError(
        'PLAN_MODE_CONFLICT',
        `Cannot confirm Plan entry: ${transition}`,
      );
    }
    enteredPlan = transition === 'updated';
    await preparation.commit();
  } catch (error) {
    const compensationFailures: unknown[] = [];
    try {
      await preparation.restore({ revertMode: enteredPlan });
    } catch (restoreError) {
      compensationFailures.push(restoreError);
    }
    if (compensationFailures.length > 0) {
      throw new AggregateError(
        [error, ...compensationFailures],
        'Plan entry failed and compensation was incomplete',
      );
    }
    throw error;
  }
}

function assertAgentEntryEnabled(options: PlanApplicationOptions): void {
  if (options.entryEnabled?.() === false || options.agentEntryEnabled?.() === false) {
    throw new PlanApplicationError('PLAN_ENTRY_DISABLED', 'Agent Plan Mode entry is disabled');
  }
}

async function keepDefault(options: PlanApplicationOptions, sessionId: string): Promise<void> {
  const transition = await options.modes.ensureDefault(sessionId);
  if (transition !== 'updated' && transition !== 'already-default') {
    throw new PlanApplicationError(
      transition === 'not-found' ? 'PLAN_SESSION_NOT_FOUND' : 'PLAN_MODE_CONFLICT',
      `Cannot keep the Session in Default mode: ${transition}`,
    );
  }
}

async function approvePlan(
  options: PlanApplicationOptions,
  input: Parameters<PlanApplication['approve']>[0],
): Promise<void> {
  const { requestId, sessionId } = input;
  const source = await resolveApprovedPlanSource(options, input);
  const identities = [
    createInternalTurnId('plan-review', requestId),
    `plan-review:${requestId}`,
  ] as const;
  await ensureApprovedPlanImplementation(options, sessionId, identities, source);
  const transition = await options.modes.ensureDefault(sessionId);
  if (transition !== 'updated' && transition !== 'already-default') {
    throw new PlanApplicationError(
      transition === 'not-found' ? 'PLAN_SESSION_NOT_FOUND' : 'PLAN_MODE_CONFLICT',
      `Cannot approve the Plan from Session mode: ${transition}`,
    );
  }
}

async function resolveApprovedPlanSource(
  options: PlanApplicationOptions,
  input: Parameters<PlanApplication['approve']>[0],
): Promise<ApprovedPlanSource> {
  const { sessionId, markdown, planPath } = input;
  if (!markdown.trim()) {
    throw new PlanApplicationError(
      'PLAN_DOCUMENT_EMPTY',
      'Persisted Plan review Markdown is empty',
    );
  }
  if (typeof planPath !== 'string' || !planPath.trim()) {
    throw new PlanApplicationError(
      'PLAN_DOCUMENT_PATH_INVALID',
      'Persisted Plan review path is empty',
    );
  }
  const document = await options.documents.resolveAndEnsure(sessionId);
  if (!isSameResolvedPath(document.canonicalPath, planPath, options.platform)) {
    throw new PlanApplicationError(
      'PLAN_DOCUMENT_PATH_MISMATCH',
      'Persisted Plan review path does not match the Session Plan document',
    );
  }
  return { markdown };
}

async function ensureApprovedPlanImplementation(
  options: PlanApplicationOptions,
  sessionId: string,
  identities: readonly [current: string, legacy: string],
  source: ApprovedPlanSource,
): Promise<void> {
  const message = approvedPlanImplementationMessage(source, options.questionnaires.resolveLocale());
  const acceptableContents = acceptableApprovedPlanContents(source);
  const candidates = await Promise.all(
    identities.map(async (identity): Promise<PlanImplementationCandidate> => {
      const [queued, receipt] = await Promise.all([
        options.queue.findByClientRequestId(sessionId, identity),
        options.receipts.findReceipt(identity),
      ]);
      if (queued) assertApprovedPlanImplementation(queued, identity, message, acceptableContents);
      if (receipt) assertApprovedPlanReceipt(receipt, sessionId, identity);
      return { identity, queued, receipt };
    }),
  );
  const receiptCandidates = candidates.filter(hasPlanImplementationReceipt);
  if (receiptCandidates.length > 1) {
    throw implementationIdentityConflict('Both current and legacy Turn receipts exist');
  }
  const receiptCandidate = receiptCandidates[0];
  if (receiptCandidate) {
    await cancelImplementationAliases(
      options,
      sessionId,
      candidates.filter(
        (candidate): candidate is QueuedPlanImplementationCandidate =>
          candidate.queued !== undefined && candidate.identity !== receiptCandidate.identity,
      ),
    );
    return;
  }
  const queued = await reconcileQueuedImplementationAliases(
    options,
    sessionId,
    identities[0],
    candidates.filter(hasQueuedPlanImplementation),
  );
  if (queued?.queued.status === 'claimed') return;
  const identity = queued?.identity ?? identities[0];
  const agentName =
    queued?.queued.agentName ?? (await options.queue.requireMutableSession(sessionId)).agentName;
  const enqueued = await options.queue.enqueue({
    session: { sessionId, agentName },
    requestedTurnId: identity,
    clientRequestId: identity,
    source: 'questionnaire',
    queuePlacement: 'front',
    message,
  });
  if (!enqueued) {
    throw new PlanApplicationError(
      'PLAN_IMPLEMENTATION_ENQUEUE_FAILED',
      'Approved Plan implementation could not be queued',
    );
  }
  assertApprovedPlanImplementation(enqueued.item, identity, message, acceptableContents);
}

interface PlanImplementationCandidate {
  readonly identity: string;
  readonly queued?: QueueItem;
  readonly receipt?: PlanImplementationReceipt;
}

interface QueuedPlanImplementationCandidate extends PlanImplementationCandidate {
  readonly queued: QueueItem;
}

interface ReceiptedPlanImplementationCandidate extends PlanImplementationCandidate {
  readonly receipt: PlanImplementationReceipt;
}

function hasQueuedPlanImplementation(
  candidate: PlanImplementationCandidate,
): candidate is QueuedPlanImplementationCandidate {
  return candidate.queued !== undefined;
}

function hasPlanImplementationReceipt(
  candidate: PlanImplementationCandidate,
): candidate is ReceiptedPlanImplementationCandidate {
  return candidate.receipt !== undefined;
}

async function reconcileQueuedImplementationAliases(
  options: PlanApplicationOptions,
  sessionId: string,
  currentIdentity: string,
  candidates: readonly QueuedPlanImplementationCandidate[],
): Promise<QueuedPlanImplementationCandidate | undefined> {
  if (candidates.length <= 1) return candidates[0];
  const claimed = candidates.filter((candidate) => candidate.queued.status === 'claimed');
  if (claimed.length > 1) {
    throw implementationIdentityConflict('Both current and legacy Queue aliases are claimed');
  }
  const selected =
    claimed[0] ??
    candidates.find((candidate) => candidate.identity === currentIdentity) ??
    candidates[0];
  if (!selected) return undefined;
  await cancelImplementationAliases(
    options,
    sessionId,
    candidates.filter((candidate) => candidate.identity !== selected.identity),
  );
  return selected;
}

async function cancelImplementationAliases(
  options: PlanApplicationOptions,
  sessionId: string,
  candidates: readonly QueuedPlanImplementationCandidate[],
): Promise<void> {
  for (const candidate of candidates) {
    const cancelled = await options.queue.cancel(sessionId, candidate.queued.itemId);
    if (!cancelled || cancelled === 'not_editable') {
      throw implementationIdentityConflict(
        `Queue alias ${candidate.identity} could not be cancelled`,
      );
    }
  }
}

function implementationIdentityConflict(message: string): PlanApplicationError {
  return new PlanApplicationError('PLAN_IMPLEMENTATION_IDENTITY_CONFLICT', message);
}

function assertApprovedPlanReceipt(
  receipt: PlanImplementationReceipt,
  sessionId: string,
  identity: string,
): void {
  if (receipt.sessionId === sessionId && receipt.turnId === identity) return;
  throw implementationIdentityConflict(
    `Turn receipt ${identity} is not owned by Session ${sessionId}`,
  );
}

function approvedPlanImplementationMessage(
  source: ApprovedPlanSource,
  locale: string,
): QueueItem['message'] {
  return {
    content: `${APPROVED_PLAN_MARKDOWN_INSTRUCTION}${source.markdown}`,
    attachments: [],
    hideUserMessage: false,
    displayContent: translateRuntimeText(locale, 'plan.implementation.display'),
  };
}

function acceptableApprovedPlanContents(source: ApprovedPlanSource): readonly string[] {
  return [APPROVED_PLAN_MARKDOWN_INSTRUCTION, ...LEGACY_APPROVED_PLAN_MARKDOWN_INSTRUCTIONS].map(
    (instruction) => `${instruction}${source.markdown}`,
  );
}

function assertApprovedPlanImplementation(
  item: QueueItem,
  identity: string,
  message: QueueItem['message'],
  acceptableContents: readonly string[],
): void {
  if (
    item.source === 'questionnaire' &&
    item.clientRequestId === identity &&
    item.requestedTurnId === identity &&
    acceptableContents.includes(item.message.content) &&
    item.message.attachments.length === 0 &&
    (message.clientIntent === undefined || item.message.clientIntent === message.clientIntent) &&
    item.message.hideUserMessage === false
  ) {
    return;
  }
  throw implementationIdentityConflict(
    `Queue identity ${identity} is not owned by the approved Plan implementation`,
  );
}

async function beginPlanQuestionnaire(
  options: PlanApplicationOptions,
  input: PlanQuestionnaireInput,
) {
  const review = input.modePayload?.planReview;
  if (review !== undefined && !review.markdown.trim()) {
    throw new PlanApplicationError('PLAN_DOCUMENT_EMPTY', 'Frozen Plan review Markdown is empty');
  }
  if (review !== undefined && (typeof review.path !== 'string' || !review.path.trim())) {
    throw new PlanApplicationError(
      'PLAN_DOCUMENT_PATH_INVALID',
      'Frozen Plan review path is empty',
    );
  }
  try {
    return await options.questionnaires.createService().beginOwned(input);
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      Reflect.get(error, 'code') === 'QUESTIONNAIRE_PENDING_CONFLICT'
    ) {
      throw new PlanApplicationError(
        'PLAN_CONFLICT_QUESTIONNAIRE',
        'Another Questionnaire is already pending',
        { cause: error },
      );
    }
    throw error;
  }
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error('Operation aborted');
}

function rejectionCode(
  reason: Extract<PlanEntryPreparationResult, { readonly status: 'rejected' }>['reason'],
): string {
  if (reason === 'plan-lifecycle-active') return 'PLAN_LIFECYCLE_ACTIVE';
  if (reason === 'plan-questionnaire-active') return 'PLAN_CONFLICT_QUESTIONNAIRE';
  if (reason === 'plan-entry-disabled') return 'PLAN_ENTRY_DISABLED';
  return 'PLAN_MODE_CONFLICT';
}

function readyPreparation(
  canonicalPath: string,
  preparedNewDraft: boolean,
  release: () => void,
  settlement: {
    readonly commit: () => Promise<void>;
    readonly restore: () => Promise<void>;
    readonly revertMode?: () => Promise<void>;
  } = {
    commit: async () => undefined,
    restore: async () => undefined,
  },
): Extract<PlanEntryPreparationResult, { readonly status: 'ready' }> {
  let state: 'open' | 'committed' | 'restored' | 'restore-failed' = 'open';
  let inFlight:
    | { readonly action: 'commit' | 'restore'; readonly promise: Promise<void> }
    | undefined;
  let restoreFailure: Promise<void> | undefined;
  const settle = async (
    action: 'commit' | 'restore',
    operation: () => Promise<void>,
  ): Promise<void> => {
    if (state === 'committed' || state === 'restored') return Promise.resolve();
    if (state === 'restore-failed')
      return restoreFailure ?? Promise.reject(new Error('restore failed'));
    if (inFlight) {
      if (inFlight.action === action) return inFlight.promise;
      try {
        await inFlight.promise;
      } catch {
        // A failed commit deliberately falls through to the compensating restore.
      }
      return settle(action, operation);
    }
    const promise = (async () => {
      try {
        await operation();
        state = action === 'commit' ? 'committed' : 'restored';
      } catch (error) {
        if (action === 'restore') state = 'restore-failed';
        throw error;
      } finally {
        inFlight = undefined;
        if (action === 'restore' || state === 'committed') release();
      }
    })();
    inFlight = { action, promise };
    if (action === 'restore') restoreFailure = promise;
    return promise;
  };
  return {
    status: 'ready',
    canonicalPath,
    preparedNewDraft,
    commit: () => settle('commit', settlement.commit),
    restore: (options) =>
      settle('restore', async () => {
        if (options?.revertMode) await settlement.revertMode?.();
        await settlement.restore();
      }),
  };
}
