/**
 * LocalWebsiteDeployClient: Local upload/publication delegate for website_deploy, implementing
 * desktop LocalWebsiteDeployAdapter.
 *
 * Option B:
 * 1. Walk and filter the local build directory: exclude .env/.git/node_modules, do not follow
 *   symlinks, and enforce a total-size limit.
 * 2. Create site.zip and optional source.zip using existing jszip, without adding tar.
 * 3. Reuse Matrix Gateway get_upload_url to obtain a presigned PUT for each temporary upload
 *   object, then upload sequentially site → source. The local process holds no OSS AK/SK.
 * 4. Call the actual backend endpoint: publish_archive for initial publication, update_archive for
 *   an existing nodeId. Both use site.zip/source.zip; source.zip is only validated and stored
 *   privately as the original ZIP, never entering stage/CDN.
 *
 * Routing: Obtain temporary upload objects through managed Matrix Gateway
 * `/mavis/api/v1/mcp/get_upload_url`; publish through Drive website
 * `/mavis/api/v1/drive/websites/publish_archive`. Gateway authenticates the Bearer access token,
 * injects BaseReq, and forwards to archon-server PublishWebsiteArchive.
 *
 * Identity: Gateway injects userId/BizLine from the managed access token; local sends only
 * sessionId as the auditing/ownership anchor.
 *
 * Prerequisite: archon-server publish_archive is deployed (separate archon_server MR). Before that,
 * the tool still appears but calls fail at the backend. If needed, add a configurable runtime gate
 * to hide incomplete capabilities in unconfigured environments.
 */

import { lstat, realpath } from 'node:fs/promises';
import { basename } from 'node:path';

import type { LocalWebsiteDeployAdapter } from '@mavis/agent-tools/desktop';

import { logger } from '../common/logger.js';
import type { LocalRuntimeAuthContext } from '../runtime/model-resolver.js';
import type { LocalRuntimeRoutingContext } from '../runtime/routing-headers.js';
import { LocalMatrixClient } from '../matrix/local-matrix-client.js';
import {
  DEFAULT_IGNORE_PATTERNS,
  sanitizeStem,
  totalBytes,
  uploadArchive,
  walkDeployableFiles,
  type UploadedArchive,
  type WebsiteDeployGateway,
} from './archive-upload.js';
import { materializeWebsiteCover } from './cover-materializer.js';
import { deployFailure, ensureNotAborted, runDeployStage } from './deploy-failure.js';

/** Drive website publication endpoint: archive oss_key → unpack + publish. */
const PUBLISH_ARCHIVE_PATH = '/mavis/api/v1/drive/websites/publish_archive';
/** Drive website update endpoint: retain the existing node and URL while replacing both archives' contents. */
const UPDATE_ARCHIVE_PATH = '/mavis/api/v1/drive/websites/update_archive';
// Mirrors IDL WebsiteManagementCode_CONTENT_REJECTED; non-zero base_resp always wins.
const CONTENT_REJECTED_CODE = 10;
const CONTENT_REJECTED_MESSAGE = '网站正文未通过审核，未发布';

const DEFAULT_UPLOAD_TIMEOUT_MS = 1_500_000;

/** Hard total-byte limit after walking files; defaults to 200 MiB, aligned with cloud. */
const DEFAULT_MAX_TOTAL_BYTES = 200 * 1024 * 1024;

export interface LocalWebsiteDeployClientOptions {
  /** Inject a gateway for tests; otherwise construct LocalMatrixClient from authContext/baseUrl. */
  gateway?: WebsiteDeployGateway;
  authContext?: LocalRuntimeAuthContext;
  routingContextGetter?: () => LocalRuntimeRoutingContext | undefined;
  baseUrl?: string;
  maxTotalBytes?: number;
  ignorePatterns?: readonly RegExp[];
  uploadTimeoutMs?: number;
  /** Desktop data root used by the existing local asset store for website covers. */
  dataDir?: string;
  /** Injectable only to keep the bounded cover download deterministic in unit tests. */
  fetchImpl?: typeof fetch;
}

export class LocalWebsiteDeployClient implements LocalWebsiteDeployAdapter {
  private readonly gateway: WebsiteDeployGateway;
  private readonly maxTotalBytes: number;
  private readonly ignorePatterns: readonly RegExp[];
  private readonly uploadTimeoutMs: number;
  private readonly dataDir: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: LocalWebsiteDeployClientOptions = {}) {
    this.gateway =
      options.gateway ??
      new LocalMatrixClient({
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
        ...(options.authContext ? { authContext: options.authContext } : {}),
        routingContextGetter: options.routingContextGetter,
      });
    this.maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    this.ignorePatterns = options.ignorePatterns ?? DEFAULT_IGNORE_PATTERNS;
    this.uploadTimeoutMs = options.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS;
    this.dataDir = options.dataDir;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async deploy(
    input: {
      dir: string;
      sourceDir?: string;
      nodeId?: string;
      projectName: string;
      sessionId: string;
      turnId?: string;
      watermark_enabled?: boolean;
    },
    signal?: AbortSignal,
  ): Promise<{
    cdn_url?: string;
    node_id?: string;
    cover_path?: string;
    error_code?: string;
    base_resp?: { status_code?: number; status_msg?: string };
  }> {
    ensureNotAborted(signal, 'before upload', 'validate_site');
    if (input.nodeId !== undefined && input.sourceDir === undefined) {
      throw deployFailure(
        'website_deploy update requires a source directory.',
        'validation_failed',
        'validate_site',
      );
    }

    // 1) Walk, filter without following symlinks, and enforce the size limit.
    const siteFiles = await runDeployStage('validate_site', signal, () =>
      walkDeployableFiles(input.dir, this.ignorePatterns),
    );
    if (siteFiles.length === 0) {
      throw deployFailure(
        `Nothing to deploy: '${input.dir}' has no files after filtering.`,
        'validation_failed',
        'validate_site',
      );
    }
    const siteBytes = totalBytes(siteFiles);
    if (siteBytes > this.maxTotalBytes) {
      throw deployFailure(
        `Directory total size ${siteBytes} bytes exceeds the ${this.maxTotalBytes}-byte deploy ` +
          `limit. Trim build output or move large assets out before deploying.`,
        'validation_failed',
        'validate_site',
      );
    }
    const sourcePresent = input.sourceDir !== undefined;
    logStage('validate_site', 'ok', {
      source_present: sourcePresent,
      bytes: siteBytes,
      files: siteFiles.length,
    });

    // 2) Package site.zip, obtain its presigned PUT, and upload; process source.zip only afterward.
    const siteUpload = await uploadArchive({
      files: siteFiles,
      archiveName: `${sanitizeStem(basename(input.dir)) || 'website'}.zip`,
      gateway: this.gateway,
      signal,
      timeoutMs: this.uploadTimeoutMs,
      source: false,
    });
    logStage('upload_site', 'ok', {
      source_present: sourcePresent,
      bytes: siteBytes,
      files: siteFiles.length,
    });

    let sourceUpload: UploadedArchive | undefined;
    let sourceBytes = 0;
    let sourceFiles = 0;
    const sourceDir = input.sourceDir;
    if (sourceDir !== undefined) {
      const sourceRootStat = await runDeployStage('validate_source', signal, () =>
        lstat(sourceDir),
      );
      if (!sourceRootStat.isDirectory()) {
        throw deployFailure(
          'website_deploy source directory must be a regular directory.',
          'validation_failed',
          'validate_source',
        );
      }
      ensureNotAborted(signal, 'before source validation', 'validate_source');
      const [siteRoot, sourceRoot] = await runDeployStage('validate_source', signal, () =>
        Promise.all([realpath(input.dir), realpath(sourceDir)]),
      );
      const sourceEntries =
        siteRoot === sourceRoot
          ? siteFiles
          : await runDeployStage('validate_source', signal, () =>
              walkDeployableFiles(sourceDir, this.ignorePatterns, input.dir),
            );
      if (sourceEntries.length === 0) {
        throw deployFailure(
          'Nothing to archive: source directory has no files after filtering.',
          'validation_failed',
          'validate_source',
        );
      }
      sourceFiles = sourceEntries.length;
      sourceBytes = totalBytes(sourceEntries);
      if (sourceBytes > this.maxTotalBytes) {
        throw deployFailure(
          `Source directory total size ${sourceBytes} bytes exceeds the ${this.maxTotalBytes}-byte ` +
            `source archive limit. Trim source files before deploying.`,
          'validation_failed',
          'validate_source',
        );
      }
      logStage('validate_source', 'ok', {
        source_present: true,
        bytes: sourceBytes,
        files: sourceFiles,
      });
      sourceUpload = await uploadArchive({
        files: sourceEntries,
        archiveName: `${sanitizeStem(basename(sourceDir)) || 'website'}-source.zip`,
        gateway: this.gateway,
        signal,
        timeoutMs: this.uploadTimeoutMs,
        source: true,
        differentFromOssKey: siteUpload.ossKey,
      });
      logStage('upload_source', 'ok', {
        source_present: true,
        bytes: sourceBytes,
        files: sourceFiles,
      });
    }

    const isUpdate = input.nodeId !== undefined;
    const archiveOperation = isUpdate ? 'update_archive' : 'publish_archive';
    const archivePath = isUpdate ? UPDATE_ARCHIVE_PATH : PUBLISH_ARCHIVE_PATH;
    ensureNotAborted(signal, `before ${archiveOperation}`, archiveOperation);
    logStage(archiveOperation, 'started', {
      source_present: sourcePresent,
      bytes: siteBytes + sourceBytes,
      files: siteFiles.length + sourceFiles,
    });
    const published = (await runDeployStage(archiveOperation, signal, () =>
      this.gateway.postGatewayJson(
        archivePath,
        {
          ...(input.nodeId !== undefined ? { node_id: input.nodeId } : {}),
          oss_key: siteUpload.ossKey,
          ...(sourceUpload ? { source_oss_key: sourceUpload.ossKey } : {}),
          project_name: input.projectName,
          session_id: input.sessionId,
          ...(input.nodeId === undefined && input.watermark_enabled !== undefined
            ? { watermark_enabled: input.watermark_enabled }
            : {}),
        },
        signal,
        this.uploadTimeoutMs,
      ),
    )) as {
      code?: number;
      message?: string;
      cdn_url?: string;
      node_id?: string;
      node?: { cdn_url?: string; node_id?: string; screenshot_url?: string };
      error_code?: string;
      base_resp?: { status_code?: number; status_msg?: string };
    };

    const baseStatusCode = published.base_resp?.status_code ?? 0;
    const statusCode = baseStatusCode !== 0 ? baseStatusCode : (published.code ?? 0);
    if (statusCode !== 0) {
      const statusMsg =
        baseStatusCode !== 0
          ? (published.base_resp?.status_msg ?? published.message)
          : statusCode === CONTENT_REJECTED_CODE
            ? CONTENT_REJECTED_MESSAGE
            : published.message;
      const errorCode =
        baseStatusCode === 0 ? normalizeNonEmptyString(published.error_code) : undefined;
      // Observability anchor for rejection. The tool layer (agent-tools/desktop local-website-deploy.ts)
      // owns no logger, and user-facing reasons depend entirely on whether the backend returns status_msg.
      // Record error_code and status_msg_present here, noting only presence, never message text,
      // consistent with this logger's no-business-content constraint. status_msg_present=false means
      // the tool can only use neutral fallback wording, allowing the exact failure branch to be reconstructed.
      logStage(archiveOperation, 'failed', {
        source_present: sourcePresent,
        bytes: siteBytes + sourceBytes,
        files: siteFiles.length + sourceFiles,
        status_code: statusCode,
        status_msg_present: Boolean(normalizeNonEmptyString(statusMsg)),
        ...(errorCode ? { error_code: errorCode } : {}),
      });
      return {
        base_resp: {
          status_code: statusCode,
          status_msg: statusMsg ?? `publish service returned status_code=${statusCode}`,
        },
        ...(errorCode ? { error_code: errorCode } : {}),
      };
    }
    const cdnUrl = published.cdn_url ?? published.node?.cdn_url ?? '';
    const returnedNodeId = normalizeNonEmptyString(published.node_id ?? published.node?.node_id);
    if (isUpdate && (!returnedNodeId || returnedNodeId !== input.nodeId || !cdnUrl)) {
      throw deployFailure(
        'website_deploy update_archive returned an invalid success response.',
        'publish_contract_failed',
        'update_archive',
      );
    }
    const nodeId = returnedNodeId ?? input.nodeId;
    const screenshotUrl = normalizeNonEmptyString(published.node?.screenshot_url);
    logStage('complete', 'ok', {
      source_present: sourcePresent,
      bytes: siteBytes + sourceBytes,
      files: siteFiles.length + sourceFiles,
    });
    // Cover acquisition is strictly best-effort after publish success. A bad or expired signed
    // URL must never rewrite a successful deployment into a retryable tool failure.
    const coverPath = await materializeWebsiteCover({
      screenshotUrl,
      nodeId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      dataDir: this.dataDir,
      fetchImpl: this.fetchImpl,
      signal,
    });
    return {
      ...(cdnUrl ? { cdn_url: cdnUrl } : {}),
      ...(nodeId ? { node_id: nodeId } : {}),
      ...(coverPath ? { cover_path: coverPath } : {}),
    };
  }
}

function normalizeNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function logStage(
  stage:
    | 'validate_site'
    | 'upload_site'
    | 'validate_source'
    | 'upload_source'
    | 'publish_archive'
    | 'update_archive'
    | 'complete',
  result: 'started' | 'ok' | 'failed',
  fields: {
    source_present: boolean;
    bytes: number;
    files: number;
    status_code?: number;
    /** Record only whether the backend supplied a business-reason message, never its contents. */
    status_msg_present?: boolean;
    error_code?: string;
  },
): void {
  logger.info({ stage, result, ...fields }, 'website deploy stage');
}
