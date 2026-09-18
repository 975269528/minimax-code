import type { IModelCapabilities } from '@mavis/protocol';

import type { LocalModelConfig } from '../contracts.js';

type CapabilityConfig = NonNullable<LocalModelConfig['capabilities']>;

/** Canonical protocol fields win over the legacy local `use_file_api` alias. */
export function normalizeLocalFileApiCapabilities(
  capabilities: CapabilityConfig | undefined,
): Pick<
  IModelCapabilities,
  | 'support_files_api'
  | 'files_api_upload_endpoint'
  | 'files_api_ref_scheme'
  | 'files_api_file_id_ttl_sec'
> {
  const enabled =
    typeof capabilities?.support_files_api === 'boolean'
      ? capabilities.support_files_api
      : capabilities?.use_file_api === true;
  if (!enabled) return { support_files_api: false };
  const endpoint = capabilities?.files_api_upload_endpoint?.trim();
  const refScheme = capabilities?.files_api_ref_scheme?.trim();
  const ttlSec = capabilities?.files_api_file_id_ttl_sec;
  return {
    support_files_api: true,
    ...(endpoint ? { files_api_upload_endpoint: endpoint } : {}),
    ...(refScheme ? { files_api_ref_scheme: refScheme } : {}),
    ...(typeof ttlSec === 'number' && Number.isFinite(ttlSec) && ttlSec >= 0
      ? { files_api_file_id_ttl_sec: ttlSec }
      : {}),
  };
}

export function normalizeLocalMultimodalLimitCapabilities(
  capabilities: CapabilityConfig | undefined,
): Pick<
  IModelCapabilities,
  | 'max_image_bytes_inline'
  | 'max_video_bytes_inline'
  | 'max_request_body_bytes'
  | 'max_attachments_count'
> {
  const maxImage = normalizePositiveByteLimit(capabilities?.max_image_bytes_inline);
  const maxVideo = normalizePositiveByteLimit(capabilities?.max_video_bytes_inline);
  const maxBody = normalizePositiveByteLimit(capabilities?.max_request_body_bytes);
  const maxCount = normalizePositiveCountLimit(capabilities?.max_attachments_count);
  return {
    ...(maxImage !== undefined ? { max_image_bytes_inline: maxImage } : {}),
    ...(maxVideo !== undefined ? { max_video_bytes_inline: maxVideo } : {}),
    ...(maxBody !== undefined ? { max_request_body_bytes: maxBody } : {}),
    ...(maxCount !== undefined ? { max_attachments_count: maxCount } : {}),
  };
}

function normalizePositiveByteLimit(value: unknown): number | string | undefined {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? trimmed : undefined;
}

function normalizePositiveCountLimit(value: unknown): number | undefined {
  let parsed = Number.NaN;
  if (typeof value === 'number') parsed = value;
  if (typeof value === 'string' && value.trim()) parsed = Number(value.trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
