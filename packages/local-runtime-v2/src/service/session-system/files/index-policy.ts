import type { SessionAssetIndexState } from './repo/contract.js';

const SESSION_ASSET_INDEX_VERSION = 1;

export function isSessionAssetIndexCurrent(
  state: SessionAssetIndexState | undefined,
  latestRowId: number,
): boolean {
  return (
    state?.status === 'ready' &&
    state.indexVersion === SESSION_ASSET_INDEX_VERSION &&
    state.indexedThroughMessageRowId >= latestRowId
  );
}
