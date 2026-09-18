import { readFile } from 'node:fs/promises';

import type { UserMessageInput } from '@mavis/agent-core/pi-turn-runner';
import {
  selectMultimodalAttachments,
  type MultimodalAttachmentCapabilities,
} from '@mavis/agent-tools';

export type LocalMultimodalAttachmentCapabilities = MultimodalAttachmentCapabilities;

export interface LocalInlineMediaCandidate {
  readonly key: string;
  readonly id: string;
  readonly mime: string;
  readonly sizeBytes: number;
  readonly filePath: string;
  readonly data?: string;
}

/** Concrete local media IO kept outside the AgentHost orchestration core. */
export async function prepareLocalInlineMedia(
  candidates: readonly LocalInlineMediaCandidate[],
  capabilities: LocalMultimodalAttachmentCapabilities | undefined,
): Promise<{
  readonly attachments: NonNullable<UserMessageInput['attachments']>;
  readonly inlinedKeys: ReadonlySet<string>;
  readonly items: readonly {
    readonly key: string;
    readonly attachment: NonNullable<UserMessageInput['attachments']>[number];
  }[];
}> {
  const selected = selectMultimodalAttachments(candidates, capabilities);
  const materialized = await Promise.all(
    selected.kept.map(async ({ candidate, mime }) => {
      const data = await readInlineMediaData(candidate);
      return data
        ? {
            key: candidate.key,
            attachment: { type: 'image' as const, data, mimeType: mime },
          }
        : undefined;
    }),
  );
  const available = materialized.filter(
    (item): item is NonNullable<typeof item> => item !== undefined,
  );
  return {
    attachments: available.map(({ attachment }) => attachment),
    items: available,
    inlinedKeys: new Set(available.map(({ key }) => key)),
  };
}

async function readInlineMediaData(
  candidate: LocalInlineMediaCandidate,
): Promise<string | undefined> {
  if (candidate.data) return candidate.data;
  try {
    return (await readFile(candidate.filePath)).toString('base64');
  } catch {
    return undefined;
  }
}
