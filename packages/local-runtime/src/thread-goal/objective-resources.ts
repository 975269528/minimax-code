import type { ThreadGoalAttachment } from '@mavis/goal';

import {
  discardLocalAssetRegistrations,
  registerMessageAttachments,
  resolveSessionLocalAsset,
} from '../assets/store.js';
import type { DataDirInput } from '../persistence/db.js';

/** Persist source bytes first; only the caller's atomic Goal write admits the references. */
export async function withPreparedGoalResources<T>(
  dataDir: DataDirInput,
  sessionId: string,
  resources: readonly ThreadGoalAttachment[] | undefined,
  commit: (resources: readonly ThreadGoalAttachment[] | undefined) => Promise<T>,
): Promise<T> {
  if (resources === undefined) return commit(undefined);
  // An existing asset must belong to this Session. Never trust a renderer path
  // just because it looks like an asset path.
  const sources = await Promise.all(
    resources.map(async (resource) => {
      if (resource.assetId) {
        const asset = await resolveSessionLocalAsset({
          dataDir,
          sessionId,
          assetId: resource.assetId,
        });
        if (!asset) throw new Error('Local attachment source is unreadable or invalid');
        return { ...resource, filePath: asset.absolutePath, dataUrl: undefined };
      }
      return resource;
    }),
  );
  const registered = await registerMessageAttachments({
    dataDir,
    sessionId,
    attachments: sources.map((resource) => ({ ...resource })),
  });
  const created = registered.flatMap((resource, index) =>
    resource.assetId && resource.assetId !== sources[index]?.assetId
      ? [{ assetId: resource.assetId, filePath: resource.filePath }]
      : [],
  );
  try {
    const durable = registered.map(({ type, filePath, fileName, mimeType, assetId }) => {
      if (!assetId || !filePath) throw new Error('asset_source_required');
      return { type, filePath, fileName, mimeType, assetId };
    });
    return await commit(durable);
  } catch (error) {
    await discardLocalAssetRegistrations({ dataDir, sessionId, receipts: created });
    throw error;
  }
}
