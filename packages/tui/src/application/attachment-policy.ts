export const MINIMAX_CODE_MAX_ATTACHMENT_COUNT = 10;
export const MINIMAX_CODE_MAX_TOTAL_ATTACHMENT_BYTES = 100 * 1024 * 1024;

export type TuiAttachmentLimitViolation = 'count' | 'total-bytes';

export function findTuiAttachmentLimitViolation(
  attachments: readonly { readonly sizeBytes: number }[],
): TuiAttachmentLimitViolation | undefined {
  if (attachments.length > MINIMAX_CODE_MAX_ATTACHMENT_COUNT) return 'count';
  const totalBytes = attachments.reduce((sum, attachment) => sum + attachment.sizeBytes, 0);
  return totalBytes > MINIMAX_CODE_MAX_TOTAL_ATTACHMENT_BYTES ? 'total-bytes' : undefined;
}
