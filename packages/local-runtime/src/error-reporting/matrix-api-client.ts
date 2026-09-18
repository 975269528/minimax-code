/**
 * Matrix Gateway client for desktop error batches.
 *
 * Transport requirements (design §4): Authentication matches existing local-runtime managed-cloud
 * calls, including content-safety `/mavis/api/v1/content` and connectors under skill-hub
 * `/minimax-cloud/api/v1/skill-hub`:
 * - POST `/minimax-cloud/api/v1/observability/desktop-errors/batch`.
 * - Like other Shared OAuth managed-cloud calls, put the access token in `Authorization: Bearer`,
 *   never query parameters; put the real user ID in the `user_id` query parameter. Excluding the
 *   token from URLs prevents Gateway, Ingress, and proxy access logs from recording it. An earlier
 *   Thrift draft used a token query parameter; current requirements follow connectors instead.
 * - Use consistent managed-backend routing headers so each environment reaches the correct backend.
 * - Require HTTPS and bound request timeouts.
 * - Missing login state, transport errors, timeouts, or non-2xx responses discard the batch and
 *   emit only token-free warnings. Reporting must not generate new error events or block callers.
 *
 * Each event_log must already be encrypted before reaching this client (see ./crypto.ts); the
 * client neither inspects nor redacts event contents.
 */

import {
  getRuntimeBuildEnv,
  getRuntimeRegion,
  type MavisBuildEnv,
  type MavisRegion,
} from '@mavis/config';

import { logger } from '../common/logger.js';
import type { LocalRuntimeAuthContext } from '../runtime/model-resolver.js';
import {
  managedBackendRoutingHeaders,
  type LocalRuntimeRoutingContext,
} from '../runtime/routing-headers.js';
import type { DesktopErrorLog } from './types.js';

/** Per-request timeout limit, consistent with other managed-cloud calls. */
const DESKTOP_ERROR_BATCH_TIMEOUT_MS = 10_000;

/** Fixed API path required by the current design, appended to the region host. */
const DESKTOP_ERROR_BATCH_PATH = '/minimax-cloud/api/v1/observability/desktop-errors/batch';

/**
 * Map region/build environment to Matrix hosts, aligned with Electron, content-safety, and
 * local-runtime managed Matrix environments.
 */
const DESKTOP_ERROR_API_HOST: Record<MavisRegion, Record<MavisBuildEnv, string>> = {
  cn: {
    dev: 'https://matrix-test.example.invalid',
    test: 'https://matrix-test.example.invalid',
    staging: 'https://matrix-pre.example.invalid',
    prod: 'https://agent.minimax.cn',
  },
  en: {
    dev: 'https://matrix-overseas-test.example.invalid',
    test: 'https://matrix-overseas-test.example.invalid',
    staging: 'https://matrix-overseas-pre.example.invalid',
    prod: 'https://agent.minimax.io',
  },
};

export interface SendDesktopErrorBatchParams {
  /** Event whose event_log has already been encrypted into the wire format. */
  events: DesktopErrorLog[];
  /** Live login state; both token and real user ID are required. */
  authContext: LocalRuntimeAuthContext | undefined;
  routingContext?: LocalRuntimeRoutingContext | undefined;
  fetchImpl: typeof fetch;
  region?: () => MavisRegion;
  buildEnv?: () => MavisBuildEnv;
}

/**
 * POST a batch of encrypted events to Gateway. Never throw or return a value requiring caller
 * handling; pipeline failures never affect the main flow. Return immediately and drop the batch if
 * login state is incomplete.
 */
export async function sendDesktopErrorBatch(params: SendDesktopErrorBatchParams): Promise<void> {
  if (params.events.length === 0) return;

  // Use the latest login state for each batch. The same token authenticates the request and derives upstream event_log keys,
  // so token refreshes between batches do not prevent Gateway decryption.
  const accessToken = params.authContext?.accessToken?.trim();
  const realUserID = params.authContext?.realUserID?.trim();
  if (!accessToken || !realUserID) {
    // Drop batches with incomplete login state per design §4.1; log no contents to avoid leaking partial authentication material.
    return;
  }

  const region = (params.region ?? getRuntimeRegion)();
  const buildEnv = (params.buildEnv ?? getRuntimeBuildEnv)();
  const requestUrl = new URL(
    `${DESKTOP_ERROR_API_HOST[region][buildEnv]}${DESKTOP_ERROR_BATCH_PATH}`,
  );
  // The Matrix API common parameter `user_id` carries uid; the token belongs only in headers.
  requestUrl.searchParams.set('user_id', realUserID);

  // Require HTTPS; never send login state over plaintext connections.
  if (requestUrl.protocol !== 'https:') return;

  try {
    const response = await params.fetchImpl(requestUrl, {
      method: 'POST',
      headers: {
        'User-Agent': 'MiniMaxAgent',
        'Content-Type': 'application/json',
        // Shared OAuth credential header, consistent with model-resolver and content-safety.
        Authorization: `Bearer ${accessToken}`,
        ...managedBackendRoutingHeaders(params.routingContext, buildEnv),
      },
      // The request body contains only the event array; neither token nor user_id belongs in it.
      body: JSON.stringify({ events: params.events }),
      signal: AbortSignal.timeout(DESKTOP_ERROR_BATCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      // Drop the batch on any non-2xx response; log only the status code, never the token or URL.
      logger.warn(
        { status: response.status, count: params.events.length },
        '[error-reporting] desktop error batch upload rejected',
      );
    }
  } catch (error) {
    // Transport error or timeout: drop the current batch without affecting the main flow.
    logger.warn(
      {
        error: error instanceof Error ? error.message : String(error),
        count: params.events.length,
      },
      '[error-reporting] desktop error batch upload failed',
    );
  }
}
