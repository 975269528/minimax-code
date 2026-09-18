interface TuiAttachmentMetadata {
  type: 'file' | 'image';
  fileName: string;
  mimeType: string;
  sizeBytes?: number;
}

export type TuiTransportAttachment = TuiAttachmentMetadata &
  ({ filePath: string; assetId?: string } | { filePath?: string; assetId: string });

export interface TuiAttachment extends TuiAttachmentMetadata {
  filePath: string;
  sizeBytes: number;
}

export interface TuiInvocation {
  content: string;
  attachments?: readonly TuiAttachment[];
}
