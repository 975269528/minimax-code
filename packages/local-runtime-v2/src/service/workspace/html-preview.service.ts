import { randomBytes } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { relative } from 'node:path';

import type {
  CreateHtmlPreviewLeaseResult,
  CreateWorkspaceHtmlPreviewOptions,
  HtmlPreviewLeaseError,
  WorkspaceHtmlPreviewResourceResult,
} from './contracts.js';
import {
  readWorkspaceHtmlPreviewResource,
  resolveContainedHtmlPreviewFile,
  resolveWorkspaceHtmlPreviewResource,
} from './html-preview-resource.js';

const HTML_PREVIEW_LEASE_TTL_MS = 30 * 60 * 1_000;
const HTML_PREVIEW_LEASE_LIMIT = 128;
const HTML_PREVIEW_ROUTE = '/mavis/api/file/html-preview';
export const HTML_PREVIEW_BRIDGE_SCRIPT_MAX_BYTES = 256 * 1024;

interface HtmlPreviewLease {
  token: string;
  rootDir: string;
  entryPath: string;
  expiresAtMs: number;
  lastAccessedAtMs: number;
  bridgeScriptTag?: string;
  ownerToken?: string;
}

export class WorkspaceHtmlPreviewService {
  private readonly leases = new Map<string, HtmlPreviewLease>();
  private closed = false;

  async create(
    workspaceDir: string,
    relativePath: string,
    nowMs = Date.now(),
    options: CreateWorkspaceHtmlPreviewOptions = {},
  ): Promise<CreateHtmlPreviewLeaseResult> {
    if (this.closed) return unavailableError();
    if (!/\.html?$/iu.test(relativePath)) {
      return {
        ok: false,
        status: 415,
        code: 'HTML_PREVIEW_UNSUPPORTED',
        error: 'Only HTML files can create an HTML preview',
      };
    }
    let rootDir: string;
    try {
      rootDir = await realpath(workspaceDir);
    } catch {
      return {
        ok: false,
        status: 404,
        code: 'WORKSPACE_NOT_FOUND',
        error: 'Workspace not found',
      };
    }
    const absolutePath = await resolveContainedHtmlPreviewFile(rootDir, relativePath);
    if (!absolutePath) {
      return {
        ok: false,
        status: 404,
        code: 'HTML_PREVIEW_NOT_FOUND',
        error: 'HTML preview file not found',
      };
    }
    if (this.closed) return unavailableError();
    this.pruneExpiredLeases(nowMs);
    const entryPath = relative(rootDir, absolutePath);
    const existing = this.findReusableLease(rootDir, entryPath, options);
    if (!existing && !this.reserveLeaseCapacity()) {
      return {
        ok: false,
        status: 429,
        code: 'HTML_PREVIEW_LIMIT_REACHED',
        error: 'Too many active HTML previews',
      };
    }
    const lease: HtmlPreviewLease = existing ?? {
      token: randomBytes(18).toString('base64url'),
      rootDir,
      entryPath,
      expiresAtMs: nowMs + HTML_PREVIEW_LEASE_TTL_MS,
      lastAccessedAtMs: nowMs,
      ...(options.managed ? { ownerToken: randomBytes(18).toString('base64url') } : {}),
    };
    lease.expiresAtMs = nowMs + HTML_PREVIEW_LEASE_TTL_MS;
    lease.lastAccessedAtMs = nowMs;
    lease.bridgeScriptTag = options.bridgeScriptTag;
    this.leases.set(lease.token, lease);
    return createdLeaseResult(lease);
  }

  update(
    token: string,
    ownerToken: string,
    action: 'renew' | 'release',
    nowMs = Date.now(),
  ): { ok: true } | HtmlPreviewLeaseError {
    this.pruneExpiredLeases(nowMs);
    const lease = this.leases.get(token);
    if (!lease) return action === 'release' ? { ok: true } : expiredLeaseError();
    if (!lease.ownerToken || lease.ownerToken !== ownerToken) {
      return {
        ok: false,
        status: 403,
        code: 'HTML_PREVIEW_FORBIDDEN',
        error: 'HTML preview owner is required',
      };
    }
    if (action === 'release') {
      this.leases.delete(token);
    } else {
      lease.expiresAtMs = nowMs + HTML_PREVIEW_LEASE_TTL_MS;
    }
    return { ok: true };
  }

  async readResource(
    token: string,
    resourcePath: string,
    rangeHeader: string | null,
    nowMs = Date.now(),
  ): Promise<WorkspaceHtmlPreviewResourceResult> {
    this.pruneExpiredLeases(nowMs);
    const lease = this.leases.get(token);
    if (!lease) return expiredLeaseError();
    const resource = await resolveWorkspaceHtmlPreviewResource(lease.rootDir, resourcePath);
    if (!resource.ok) return resource;
    lease.lastAccessedAtMs = nowMs;
    if (!lease.ownerToken) lease.expiresAtMs = nowMs + HTML_PREVIEW_LEASE_TTL_MS;
    return readWorkspaceHtmlPreviewResource(resource, rangeHeader, lease.bridgeScriptTag);
  }

  close(): void {
    this.closed = true;
    this.leases.clear();
  }

  private pruneExpiredLeases(nowMs: number): void {
    for (const [token, lease] of this.leases) {
      if (lease.expiresAtMs <= nowMs) this.leases.delete(token);
    }
  }

  private findReusableLease(
    rootDir: string,
    entryPath: string,
    options: CreateWorkspaceHtmlPreviewOptions,
  ): HtmlPreviewLease | undefined {
    // Give each iframe its own bridge and managed lease to avoid overwriting other previews' state.
    if (options.bridgeScriptTag || options.managed) return undefined;
    return [...this.leases.values()].find(
      (lease) =>
        lease.rootDir === rootDir &&
        lease.entryPath === entryPath &&
        !lease.bridgeScriptTag &&
        !lease.ownerToken,
    );
  }

  private reserveLeaseCapacity(): boolean {
    if (this.leases.size < HTML_PREVIEW_LEASE_LIMIT) return true;
    const oldest = [...this.leases.values()]
      .filter((lease) => !lease.ownerToken)
      .sort((left, right) => left.lastAccessedAtMs - right.lastAccessedAtMs)[0];
    if (!oldest) return false;
    this.leases.delete(oldest.token);
    return true;
  }
}

function createdLeaseResult(lease: HtmlPreviewLease): CreateHtmlPreviewLeaseResult {
  return {
    ok: true,
    url: `${HTML_PREVIEW_ROUTE}/${lease.token}/${encodeRoutePath(lease.entryPath)}`,
    ...(lease.ownerToken ? { lease: { token: lease.token, ownerToken: lease.ownerToken } } : {}),
  };
}

function expiredLeaseError(): HtmlPreviewLeaseError {
  return { ok: false, status: 410, code: 'PREVIEW_EXPIRED', error: 'HTML preview expired' };
}

function unavailableError(): HtmlPreviewLeaseError {
  return {
    ok: false,
    status: 503,
    code: 'HTML_PREVIEW_UNAVAILABLE',
    error: 'HTML preview is unavailable on this runtime',
  };
}

function encodeRoutePath(value: string): string {
  return value
    .replace(/\\/gu, '/')
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}
