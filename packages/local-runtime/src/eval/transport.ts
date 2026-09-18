import type { EvalMetaInfo } from '@mavis/shared/eval-meta-info';
import { logger } from '../common/logger.js';
import type {
  EvalReportRequest,
  LocalEvalReporterFactoryOptions,
  ReportEvalStepsResponse,
} from './types.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/** Uploads one serialized eval request; every transport/protocol failure is fail-open. */
export async function uploadLocalEvalRequest(input: {
  readonly request: EvalReportRequest;
  readonly sessionId: string;
  readonly options: LocalEvalReporterFactoryOptions;
  readonly fetchImpl: typeof fetch;
  readonly accessToken: string;
}): Promise<void> {
  const { request, sessionId } = input;
  try {
    const response = await input.fetchImpl(endpointFor(request, input.options), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        'User-Agent': 'MiniMaxAgent',
        'X-Mavis-Desktop-Channel': 'desktop',
        'Content-Type': 'application/json',
      },
      body: request.body,
      signal: AbortSignal.timeout(input.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
    });
    const responseText = await response.text();
    if (!response.ok) {
      logger.warn(
        { sessionId, status: response.status },
        `[eval-capture] local eval_${request.kind} upload failed`,
      );
      return;
    }
    let payload: ReportEvalStepsResponse;
    try {
      payload = JSON.parse(responseText) as ReportEvalStepsResponse;
    } catch {
      logger.warn(
        { sessionId, status: response.status },
        `[eval-capture] local eval_${request.kind} upload returned non-JSON response`,
      );
      return;
    }
    if (typeof payload.base_resp?.status_code === 'number' && payload.base_resp.status_code !== 0) {
      logger.warn(
        {
          sessionId,
          statusCode: payload.base_resp.status_code,
          statusMessage:
            typeof payload.base_resp.status_msg === 'string'
              ? payload.base_resp.status_msg.slice(0, 200)
              : undefined,
        },
        `[eval-capture] local eval_${request.kind} upload returned a business error`,
      );
    } else if (typeof payload.error === 'string' && payload.error.length > 0) {
      logger.warn(
        { sessionId, error: payload.error.slice(0, 200) },
        `[eval-capture] local eval_${request.kind} upload returned an error`,
      );
    }
  } catch (error) {
    logger.warn(
      { sessionId, error: error instanceof Error ? error.message : String(error) },
      `[eval-capture] local eval_${request.kind} upload failed`,
    );
  }
}

function endpointFor(request: EvalReportRequest, options: LocalEvalReporterFactoryOptions): string {
  if (request.kind === 'steps') return options.endpoint;
  if (options.snapshotEndpoint) return options.snapshotEndpoint;
  const endpoint = new URL(options.endpoint);
  if (!endpoint.pathname.endsWith('/steps/report')) {
    throw new Error('eval steps endpoint must end with /steps/report');
  }
  endpoint.pathname = `${endpoint.pathname.slice(0, -'/steps/report'.length)}/snapshot/report`;
  return endpoint.toString();
}

/** Auth and metadata readers are fail-open, like the HTTP transport. */
export function readLocalEvalAccessToken(
  options: LocalEvalReporterFactoryOptions,
): string | undefined {
  try {
    return options.getAccessToken()?.trim() || undefined;
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      '[eval-capture] failed to read local eval access token',
    );
    return undefined;
  }
}

export async function collectLocalEvalMetaInfo(
  options: LocalEvalReporterFactoryOptions,
  workspaceDir: string,
): Promise<EvalMetaInfo | undefined> {
  if (!options.getMetaInfo) return undefined;
  try {
    return await options.getMetaInfo(workspaceDir);
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      '[eval-capture] failed to collect local MetaInfo',
    );
    return undefined;
  }
}
