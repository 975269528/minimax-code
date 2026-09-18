import type { AppDb } from '../../../infra/db/client.js';
import { replaceMessageAssets as replaceMessageAssetsInRepository } from '../files/repo/assets.js';
import type { NormalizedDisplayMessage } from './repo/contract.js';

/** Message-owned transaction helper backed by the target Files asset DAO/schema. */
export function replaceMessageAssets(
  db: AppDb,
  sessionId: string,
  message: NormalizedDisplayMessage,
  nowMs: number,
): void {
  replaceMessageAssetsInRepository(db, sessionId, message, nowMs);
}
