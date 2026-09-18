import type {
  SessionCanonicalHistoryChange,
  SessionSystemCanonicalHistoryProvider,
} from '../../../session-system/index.js';
import { isUserMessageId } from '../../../session-system/index.js';
import { prepareSteeringTeardownCanonicalInput } from '../../agent-host/assembly/local-turn-input-preparation.js';
import type { AgentHostSteeringMessage } from '../../agent-host/contracts.js';

/**
 * Decision v5 fall-to-session commit: persists admitted-but-unconsumed user
 * steering of an abnormally ended Turn into the conversation itself — the
 * `steered_user` display row (via the delivery-service projection) plus the
 * canonical history user row the next model request reads. Nothing returns
 * to the Session queue and no wake or new Turn is produced here; an explicit
 * per-message model selection is deliberately dropped (rule 6).
 */
export interface SteeringTeardownCommitOptions {
  /**
   * Display-side projection: `UserMessageTurnDelivery.consumeSteering`
   * semantics without the `session.start` publication — it must only commit
   * the visible `steered_user` row and its `message-committed` stream frame.
   */
  readonly projectDisplay: (input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly message: AgentHostSteeringMessage;
  }) => Promise<void>;
  readonly canonicalHistory: Pick<
    SessionSystemCanonicalHistoryProvider,
    'inspectActive' | 'append'
  >;
  readonly nowMs?: () => number;
  readonly logger?: {
    warn(fields: Record<string, unknown>, message: string): void;
  };
}

export interface SteeringTeardownCommit {
  /** Resolves true only when every message is durably in the conversation. */
  commit(input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly messages: readonly AgentHostSteeringMessage[];
    /**
     * Per-message durability progress: fires once a message's display and
     * canonical rows are both committed (or found already durable). A partial
     * failure lets the caller trim retries and the requeue fallback to the
     * unpersisted suffix instead of duplicating rows that already live in
     * the conversation. Observer failures are swallowed.
     */
    readonly onCommitted?: (message: AgentHostSteeringMessage) => void;
  }): Promise<boolean>;
}

export function createSteeringTeardownCommit(
  options: SteeringTeardownCommitOptions,
): SteeringTeardownCommit {
  return {
    async commit({ sessionId, turnId, messages, onCommitted }) {
      // Retries re-enter here after a partial failure: the identity vector
      // lets already-appended rows be skipped instead of throwing on the
      // duplicate-identity boundary. An unreadable vector degrades to the
      // per-append duplicate tolerance below.
      const identityVector = await readIdentityVector(options, sessionId);
      for (const message of messages) {
        try {
          await options.projectDisplay({ sessionId, turnId, message });
          await appendCanonicalUserRow(options, { sessionId, turnId, message, identityVector });
        } catch (error) {
          options.logger?.warn(
            {
              sessionId,
              turnId,
              producerId: message.producerId,
              idempotencyKey: message.idempotencyKey,
              error: `${error}`,
            },
            'Steering teardown could not commit a message into the conversation',
          );
          // Stop at the first failure so a retry preserves the send order.
          return false;
        }
        reportCommitted(onCommitted, message);
      }
      return true;
    },
  };
}

/** Progress observers are advisory; their failure never undoes a durable commit. */
function reportCommitted(
  onCommitted: ((message: AgentHostSteeringMessage) => void) | undefined,
  message: AgentHostSteeringMessage,
): void {
  try {
    onCommitted?.(message);
  } catch {
    // The message is durable either way; the observer only trims fallbacks.
  }
}

async function readIdentityVector(
  options: SteeringTeardownCommitOptions,
  sessionId: string,
): Promise<readonly string[] | undefined> {
  try {
    return (await options.canonicalHistory.inspectActive(sessionId)).identityVector;
  } catch {
    return undefined;
  }
}

async function appendCanonicalUserRow(
  options: SteeringTeardownCommitOptions,
  input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly message: AgentHostSteeringMessage;
    readonly identityVector: readonly string[] | undefined;
  },
): Promise<void> {
  const userMessageId = hintedUserMessageId(input.message);
  if (userMessageId && input.identityVector?.includes(userMessageId)) return;
  try {
    await options.canonicalHistory.append(teardownAppendChange(options, input, userMessageId));
  } catch (error) {
    // A duplicated append identity means the row is already durable — a
    // retry after a partial display/canonical failure must not throw here.
    if (isDuplicateIdentityError(error)) return;
    throw error;
  }
}

/** Only a well-formed display id may become a `display-user` identity hint. */
function hintedUserMessageId(message: AgentHostSteeringMessage): string | undefined {
  return message.userMessageId !== undefined && isUserMessageId(message.userMessageId)
    ? message.userMessageId
    : undefined;
}

function teardownAppendChange(
  options: SteeringTeardownCommitOptions,
  input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly message: AgentHostSteeringMessage;
  },
  userMessageId: string | undefined,
): SessionCanonicalHistoryChange {
  const { message } = input;
  // Same canonical conversion as the consumption path: quoted-message text
  // rendering, the attachment reminder with exact paths, and any inline
  // data-URL images the message already carries (Decision v5, TS-74).
  const canonical = prepareSteeringTeardownCanonicalInput({
    message: message.message,
    provenance: message.provenance,
  });
  const row = {
    role: 'user' as const,
    content: [{ type: 'text' as const, text: canonical.text }, ...canonical.attachments],
    timestamp: message.createdAt ?? options.nowMs?.() ?? Date.now(),
    ...(message.genuineUserQueryText !== undefined
      ? { genuineUserQueryText: message.genuineUserQueryText }
      : {}),
  };
  return {
    sessionId: input.sessionId,
    turnId: input.turnId,
    reason: 'messageDelta',
    messages: [row],
    ...(userMessageId
      ? { identityHints: [{ index: 0, messageId: userMessageId, source: 'display-user' as const }] }
      : {}),
    operation: {
      id: `steering-teardown:${input.turnId}:${message.producerId}:${message.idempotencyKey}`,
      kind: 'steering-teardown',
    },
  };
}

function isDuplicateIdentityError(error: unknown): boolean {
  return error instanceof TypeError && /identity is duplicated/.test(error.message);
}
