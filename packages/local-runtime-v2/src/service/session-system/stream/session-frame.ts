export type SessionFrameKind =
  | 'runtime-event'
  | 'action-required'
  | 'session-status'
  | 'turn-terminal'
  | 'message-committed'
  | 'messages-replaced'
  | 'messages-rewound'
  | 'query-collapse-view'
  | 'durable-message'
  | 'resync-required';

export interface SessionMessageActionDelta {
  readonly messageId: string;
  readonly actions: {
    readonly fork?: true;
    readonly rewind?: true;
  };
}

export interface SessionFrame {
  readonly identity: string;
  readonly sessionId: string;
  readonly kind: SessionFrameKind;
  readonly data: unknown;
  readonly cursor?: string;
  readonly turnId?: string;
  readonly messageActionDeltas?: readonly SessionMessageActionDelta[];
  readonly createdAtMs: number;
}

export interface SessionFrameInput {
  readonly identity: string;
  readonly sessionId: string;
  readonly kind: Exclude<SessionFrameKind, 'durable-message' | 'resync-required'>;
  readonly data: unknown;
  readonly turnId?: string;
  readonly messageActionDeltas?: readonly SessionMessageActionDelta[];
  readonly createdAtMs?: number;
}

export interface SessionFrameWriteResult {
  readonly appended: boolean;
  readonly retained: boolean;
  readonly frame: SessionFrame;
}

export interface SessionStreamWriter {
  write(input: SessionFrameInput): SessionFrameWriteResult;
}
