import type { LocalRuntimeRoutingContext } from '../runtime/routing-headers.js';
import type { LocalRuntimeAuthContext } from '../runtime/model-resolver.js';
import { LocalMatrixClient } from '../matrix/local-matrix-client.js';

const WEBSITE_STATE_GET_PATH = '/mavis/api/v1/drive/websites/state/get';
const WEBSITE_LIST_PATH = '/mavis/api/v1/drive/websites/list';
const WEBSITE_LIST_MAX_OFFSET = 2_147_483_647;
const WEBSITE_TRAFFIC_GET_PATH = '/mavis/api/v1/drive/websites/traffic/get';
const WEBSITE_WATERMARK_UPDATE_PATH = '/mavis/api/v1/drive/websites/watermark/update';
const WEBSITE_ALIAS_CHECK_PATH = '/mavis/api/v1/drive/websites/alias/check';
const WEBSITE_NAME_UPDATE_PATH = '/mavis/api/v1/drive/websites/name/update';
const WEBSITE_ALIAS_SET_PATH = '/mavis/api/v1/drive/websites/alias/set';
const WEBSITE_ALIAS_UNBIND_PATH = '/mavis/api/v1/drive/websites/alias/unbind';
const WEBSITE_ALIAS_REMOVE_PATH = '/mavis/api/v1/drive/websites/alias/remove';
const WEBSITE_DEPLOYMENT_CANCEL_PATH = '/mavis/api/v1/drive/websites/deployment/cancel';
const WEBSITE_UNPUBLISH_PATH = '/mavis/api/v1/drive/websites/deployment/unpublish';
const WEBSITE_REPUBLISH_PATH = '/mavis/api/v1/drive/websites/deployment/republish';
const WEBSITE_PROJECT_SOURCE_DOWNLOAD_URL_PATH =
  '/mavis/api/v1/drive/websites/project-source/download-url';

export interface WebsiteManagementGateway {
  postGatewayJson(
    pathname: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>>;
}

export interface LocalWebsiteManagementClientOptions {
  gateway?: WebsiteManagementGateway;
  authContext?: LocalRuntimeAuthContext;
  routingContextGetter?: () => LocalRuntimeRoutingContext | undefined;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export type WebsiteTrafficGranularity = 'hour' | 'day';
export type WebsiteListSortBy = 'deployed_at' | 'updated_at';
export type WebsiteListSortOrder = 'asc' | 'desc';

export interface WebsiteListSortOptions {
  sortBy?: WebsiteListSortBy;
  sortOrder?: WebsiteListSortOrder;
}

export interface WebsiteTrafficQuery {
  path?: string;
  granularity?: WebsiteTrafficGranularity;
}

export class LocalWebsiteManagementClient {
  private readonly gateway: WebsiteManagementGateway;

  constructor(options: LocalWebsiteManagementClientOptions = {}) {
    this.gateway =
      options.gateway ??
      new LocalMatrixClient({
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
        ...(options.authContext ? { authContext: options.authContext } : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        routingContextGetter: options.routingContextGetter,
      });
  }

  listWebsites(
    offset: number,
    limit: number,
    sort: WebsiteListSortOptions = {},
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return this.post(
      WEBSITE_LIST_PATH,
      { ...requireWebsitePage(offset, limit), ...requireWebsiteListSort(sort) },
      signal,
    );
  }

  getState(nodeId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.post(WEBSITE_STATE_GET_PATH, { node_id: requireNodeId(nodeId) }, signal);
  }

  getTraffic(
    nodeId: string,
    days: number,
    query: WebsiteTrafficQuery = {},
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = {
      node_id: requireNodeId(nodeId),
      days: requireWebsiteTrafficDays(days),
    };
    if (query.path !== undefined) {
      body.path = query.path;
    }
    if (query.granularity !== undefined) {
      body.granularity = requireWebsiteTrafficGranularity(query.granularity);
    }
    return this.post(WEBSITE_TRAFFIC_GET_PATH, body, signal);
  }

  updateWatermark(
    nodeId: string,
    enabled: boolean,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (typeof enabled !== 'boolean') throw new Error('watermark_enabled must be a boolean.');
    return this.post(
      WEBSITE_WATERMARK_UPDATE_PATH,
      { node_id: requireNodeId(nodeId), watermark_enabled: enabled },
      signal,
    );
  }

  updateName(
    nodeId: string,
    displayName: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const normalizedDisplayName = displayName.trim();
    if (!normalizedDisplayName) throw new Error('display_name must not be empty.');
    return this.post(
      WEBSITE_NAME_UPDATE_PATH,
      { node_id: requireNodeId(nodeId), display_name: normalizedDisplayName },
      signal,
    );
  }

  setAlias(nodeId: string, alias: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.post(
      WEBSITE_ALIAS_SET_PATH,
      { node_id: requireNodeId(nodeId), alias: requireAlias(alias) },
      signal,
    );
  }

  checkAlias(
    nodeId: string,
    alias: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return this.post(
      WEBSITE_ALIAS_CHECK_PATH,
      { node_id: requireNodeId(nodeId), alias: requireAlias(alias) },
      signal,
    );
  }

  unbindAlias(
    nodeId: string,
    alias: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return this.post(
      WEBSITE_ALIAS_UNBIND_PATH,
      { node_id: requireNodeId(nodeId), alias: requireAlias(alias) },
      signal,
    );
  }

  removeAlias(nodeId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.post(WEBSITE_ALIAS_REMOVE_PATH, { node_id: requireNodeId(nodeId) }, signal);
  }

  cancel(nodeId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.post(WEBSITE_DEPLOYMENT_CANCEL_PATH, { node_id: requireNodeId(nodeId) }, signal);
  }

  unpublish(nodeId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.post(WEBSITE_UNPUBLISH_PATH, { node_id: requireNodeId(nodeId) }, signal);
  }

  republish(nodeId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.post(WEBSITE_REPUBLISH_PATH, { node_id: requireNodeId(nodeId) }, signal);
  }

  getProjectSourceDownloadUrl(
    nodeId: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return this.post(
      WEBSITE_PROJECT_SOURCE_DOWNLOAD_URL_PATH,
      { node_id: requireNodeId(nodeId) },
      signal,
    );
  }

  private post(
    pathname: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return this.gateway.postGatewayJson(pathname, body, signal);
  }
}

function requireNodeId(nodeId: string): string {
  const normalized = nodeId.trim();
  if (!normalized) throw new Error('node_id is required.');
  return normalized;
}

function requireAlias(alias: string): string {
  const normalized = typeof alias === 'string' ? alias.trim() : '';
  if (!normalized) throw new Error('alias must not be empty.');
  return normalized;
}

function requireWebsitePage(offset: number, limit: number): { offset: number; limit: number } {
  if (!Number.isInteger(offset) || offset < 0 || offset > WEBSITE_LIST_MAX_OFFSET) {
    throw new Error(`offset must be an integer between 0 and ${WEBSITE_LIST_MAX_OFFSET}.`);
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('limit must be an integer between 1 and 100.');
  }
  return { offset, limit };
}

function requireWebsiteListSort(sort: WebsiteListSortOptions): {
  sort_by: WebsiteListSortBy;
  sort_order: WebsiteListSortOrder;
} {
  const sortBy = sort.sortBy ?? 'updated_at';
  const sortOrder = sort.sortOrder ?? 'desc';
  if (sortBy !== 'deployed_at' && sortBy !== 'updated_at') {
    throw new Error('sort_by must be deployed_at or updated_at.');
  }
  if (sortOrder !== 'asc' && sortOrder !== 'desc') {
    throw new Error('sort_order must be asc or desc.');
  }
  return { sort_by: sortBy, sort_order: sortOrder };
}

function requireWebsiteTrafficDays(days: number): number {
  if (days !== 7 && days !== 30) throw new Error('days must be 7 or 30.');
  return days;
}

function requireWebsiteTrafficGranularity(
  granularity: WebsiteTrafficGranularity,
): WebsiteTrafficGranularity {
  if (granularity !== 'hour' && granularity !== 'day') {
    throw new Error('granularity must be hour or day.');
  }
  return granularity;
}

export {
  WEBSITE_ALIAS_CHECK_PATH,
  WEBSITE_ALIAS_REMOVE_PATH,
  WEBSITE_ALIAS_SET_PATH,
  WEBSITE_ALIAS_UNBIND_PATH,
  WEBSITE_DEPLOYMENT_CANCEL_PATH,
  WEBSITE_LIST_MAX_OFFSET,
  WEBSITE_LIST_PATH,
  WEBSITE_NAME_UPDATE_PATH,
  WEBSITE_PROJECT_SOURCE_DOWNLOAD_URL_PATH,
  WEBSITE_REPUBLISH_PATH,
  WEBSITE_STATE_GET_PATH,
  WEBSITE_TRAFFIC_GET_PATH,
  WEBSITE_UNPUBLISH_PATH,
  WEBSITE_WATERMARK_UPDATE_PATH,
};
