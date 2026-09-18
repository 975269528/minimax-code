import type {
  CanonicalHistoryCommit,
  CanonicalHistorySnapshot,
  HistoryIdentityVector,
} from './contracts.js';
import { captureSemanticSnapshot } from './semantic-identity.js';

/**
 * Tracks only the latest committed snapshot and whether the current attempt
 * has durable canonical effects. It never treats the pre-Turn snapshot as a
 * writable rollback template.
 */
export class TurnCommittedHistoryState {
  private current: CanonicalHistorySnapshot['messages'];
  private currentIdentityVector?: HistoryIdentityVector;
  private dirty = false;

  constructor(initial: CanonicalHistorySnapshot) {
    this.current = captureSemanticSnapshot(initial.messages).value;
    this.currentIdentityVector = initial.identityVector;
  }

  record(commit: CanonicalHistoryCommit, retracted = false): void {
    this.current = captureSemanticSnapshot(commit.messages).value;
    this.currentIdentityVector = commit.identityVector;
    this.dirty = !retracted;
  }

  get currentIdentityVectorValue(): HistoryIdentityVector | undefined {
    return this.currentIdentityVector;
  }

  /** Canonical history committed so far during this turn. */
  get currentMessages(): CanonicalHistorySnapshot['messages'] {
    return this.current;
  }

  get hasDurableChanges(): boolean {
    return this.dirty;
  }
}
