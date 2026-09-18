import type {
  AttachmentInput,
  ModelSelectionInput,
} from "@mavis/protocol/local";
import type {
  QueueItem,
  QueueUpdateInput,
  QueueReorderInput,
} from "../../service/session-system/index.js";
import type { toQueuedMessageItemView } from "./wire.js";

export interface QueueSessionInput {
  readonly id: QueueItem["sessionId"];
}
export type QueueItemInput = QueueSessionInput & Pick<QueueItem, "itemId">;
export type QueueEditInput = QueueItemInput &
  Pick<QueueUpdateInput, "expiresAt"> & {
    readonly content?: string;
    readonly attachments?: AttachmentInput[];
    readonly model?: ModelSelectionInput;
  };
export type QueueOrderInput = QueueSessionInput & {
  readonly itemIds: Array<QueueReorderInput["itemIds"][number]>;
};
export type QueueItemResult = {
  item: ReturnType<typeof toQueuedMessageItemView>;
};
export type QueueOrderResult = {
  items: ReturnType<typeof toQueuedMessageItemView>[];
};
export type QueueSnapshotResult = QueueOrderResult & {
  paused: boolean;
  pendingCount: number;
};
