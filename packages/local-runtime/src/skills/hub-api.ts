import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  getRuntimeBuildEnv,
  getRuntimeRegion,
  isManagedRuntime,
  type MavisBuildEnv,
  type MavisRegion,
} from '@mavis/config';
import type { SkillSourceType } from '@mavis/protocol/local';

import { json, readJsonBody } from '../api/host-helpers.js';
import { LocalSkillHubInstallError } from './hub-errors.js';
import { writeInstalledSkill, type LocalSkillInstallFile } from './hub-install.js';
import { deriveSkillName, resolveInstallSkillName } from './skill-name-utils.js';
import {
  scanRemoteSkillArchiveSource,
  selectRemoteSkillInstall,
  toLocalSkillPreviewResp,
  type LocalSkillArchiveScan,
  type LocalSkillPreviewResp,
} from './remote/archive.js';
import {
  remoteSkillArchiveCacheKeys,
  remoteSkillInstallHint,
  remoteSkillUrlCacheKey,
  RemoteSkillPreviewCache,
} from './remote/cache.js';
import type { InstalledSkillHubMetadata } from './registry-operations.js';
import {
  managedBackendRoutingHeaders,
  type LocalRuntimeRoutingContext,
} from '../runtime/routing-headers.js';
import type { LocalRuntimeAuthContext } from '../runtime/model-resolver.js';

export { LocalSkillHubInstallError } from './hub-errors.js';
export type {
  LocalSkillPreviewCandidate,
  LocalSkillPreviewRepoInfo,
  LocalSkillPreviewResp,
} from './remote/archive.js';

export interface LocalSkillHubItem {
  id: number;
  name: string;
  display_name?: string;
  description: string;
  content: string;
  source_url: string;
  source_type: number;
  /** Marketplace publisher class, separate from the editable local file source type. */
  publisher_source_type?: SkillSourceType;
  use_count?: number;
  creator_info?: LocalSkillHubCreatorInfo;
  added: boolean;
  created_at: number;
  updated_at: number;
}

export type LocalSkillHubListItem = Omit<LocalSkillHubItem, 'source_type'> & {
  /** Marketplace publisher class. Missing for legacy local copies with unknown provenance. */
  source_type?: SkillSourceType;
};

export interface InstalledSkillHubIdentities {
  readonly names: ReadonlySet<string>;
  readonly sourceUrls: ReadonlySet<string>;
}

export interface LocalSkillHubCreatorInfo {
  user_id?: string;
  user_name?: string;
  avatar_url?: string;
}

interface LocalSkillHubFile {
  skills: LocalSkillHubItem[];
  installed: Record<string, number>;
}
export interface LocalSkillHubStoreOptions {
  dataDir: () => string;
  nowMs?: () => number;
  remoteEnabled?: () => boolean;
  fetch?: typeof fetch;
  region?: () => MavisRegion;
  buildEnv?: () => MavisBuildEnv;
  authContextGetter?: () => LocalRuntimeAuthContext | undefined;
  routingContextGetter?: () => LocalRuntimeRoutingContext | undefined;
}

const USER_SOURCE_TYPE: SkillSourceType = 2;
const OFFICIAL_SOURCE_TYPE: SkillSourceType = 1;
const SOURCE_TYPE_ALL = 0;
const REMOTE_SKILL_SORT_TYPE_USE_COUNT = 1;
const REMOTE_SKILL_HUB_TIMEOUT_MS = 10_000;
const AGENT_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;
const SKILL_HUB_BASE: Record<MavisRegion, Record<MavisBuildEnv, string>> = {
  cn: {
    dev: 'https://agent.minimax.cn/minimax-cloud/api/v1/skill-hub',
    test: 'https://agent.minimax.cn/minimax-cloud/api/v1/skill-hub',
    staging: 'https://agent.minimax.cn/minimax-cloud/api/v1/skill-hub',
    prod: 'https://agent.minimax.cn/minimax-cloud/api/v1/skill-hub',
  },
  en: {
    dev: 'https://agent.minimax.io/minimax-cloud/api/v1/skill-hub',
    test: 'https://agent.minimax.io/minimax-cloud/api/v1/skill-hub',
    staging: 'https://agent.minimax.io/minimax-cloud/api/v1/skill-hub',
    prod: 'https://agent.minimax.io/minimax-cloud/api/v1/skill-hub',
  },
};

export class LocalSkillHubStore {
  private readonly remoteSkillPreviewCache: RemoteSkillPreviewCache;

  constructor(private readonly options: LocalSkillHubStoreOptions) {
    this.remoteSkillPreviewCache = new RemoteSkillPreviewCache(() => this.nowMs());
  }

  async list(input: {
    keyword?: string;
    limit?: number;
    nextToken?: string;
    sourceType?: number | string;
    sortType?: number | string;
  }): Promise<{ skill_list: LocalSkillHubListItem[]; has_more: boolean; next_token: string }> {
    const file = await this.readFile();
    const sourceType = readOptionalNumber(input.sourceType);
    const sortType = readOptionalNumber(input.sortType);
    const remote = await this.queryRemote({ ...input, sourceType, sortType }, file);
    if (remote) return remote;

    const keyword = input.keyword?.trim().toLowerCase();
    const filtered = file.skills.filter((skill) => {
      if (
        sourceType !== undefined &&
        sourceType !== SOURCE_TYPE_ALL &&
        skill.publisher_source_type !== sourceType
      ) {
        return false;
      }
      if (!keyword) return true;
      return (
        skill.name.toLowerCase().includes(keyword) ||
        skill.description.toLowerCase().includes(keyword) ||
        // Match display_name so hub-installed skills whose internal SKILL.md
        // name differs from the localized display name the user saw during
        // install remain discoverable by that name.
        (skill.display_name?.toLowerCase().includes(keyword) ?? false)
      );
    });
    const start = Math.max(0, Number.parseInt(input.nextToken ?? '0', 10) || 0);
    const limit = input.limit && input.limit > 0 ? input.limit : filtered.length;
    const page = filtered.slice(start, start + limit);
    const next = start + page.length;
    return {
      skill_list: page.map((skill) => ({
        // skill-hub.json is an install ledger, not a cached Marketplace
        // catalog. Even added=false rows are previously installed local
        // copies, whose legacy source_type=2 only means "editable".
        id: skill.id,
        name: skill.name,
        ...(skill.display_name ? { display_name: skill.display_name } : {}),
        description: skill.description,
        content: skill.content,
        source_url: skill.source_url,
        ...(skill.publisher_source_type !== undefined
          ? {
              source_type: skill.publisher_source_type,
              publisher_source_type: skill.publisher_source_type,
            }
          : {}),
        ...(skill.use_count !== undefined ? { use_count: skill.use_count } : {}),
        ...(skill.creator_info ? { creator_info: skill.creator_info } : {}),
        added: file.installed[skill.name] !== undefined || skill.added,
        created_at: skill.created_at,
        updated_at: skill.updated_at,
      })),
      has_more: next < filtered.length,
      next_token: next < filtered.length ? String(next) : '',
    };
  }

  async install(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const file = await this.readFile();
    const sourceUrl =
      readString(body['url']) ??
      readString(body['skillRef']) ??
      readString(body['skill_ref']) ??
      readString(body['source_url']) ??
      'local-skill-hub://manual';
    const displayName =
      readString(body['display_name']) ??
      readString(body['displayName']) ??
      readString(body['name']) ??
      deriveSkillName(sourceUrl);
    const explicitName = readString(body['name']);
    const agentName = readString(body['agent_name']) ?? readString(body['agentName']);
    const creatorInfo = normalizeCreatorInfo(body['creator_info']);
    const requestedPublisherSourceType = normalizePublisherSourceType(
      body['publisher_source_type'] ?? body['publisherSourceType'],
    );
    validateAgentName(agentName);
    let explicitContent = readString(body['content']);
    let installFiles: LocalSkillInstallFile[] | undefined;
    const now = this.nowMs();
    // Identify the source hub item by its stable source URL. Matching by a name
    // derived from the (possibly non-ASCII) display name collapsed every such
    // skill onto the same slug, so installs/deletes clobbered each other
    // (Meego 7034556857 / 7034606585 / 7034460887).
    const existing =
      file.skills.find((skill) => skill.source_url === sourceUrl) ??
      (explicitName ? file.skills.find((skill) => skill.name === explicitName) : undefined);
    const publisherSourceType = requestedPublisherSourceType ?? existing?.publisher_source_type;
    const resolvedCreatorInfo =
      creatorInfo && existing?.creator_info
        ? { ...existing.creator_info, ...creatorInfo }
        : (creatorInfo ?? existing?.creator_info);
    if (!explicitContent && isHttpUrl(sourceUrl)) {
      const remoteInstall = await this.fetchRemoteSkillInstall(sourceUrl);
      explicitContent = remoteInstall.content;
      installFiles = remoteInstall.files;
    }
    if (!explicitContent && !existing?.content) {
      throw new LocalSkillHubInstallError(
        'Local skill-hub install requires inline skill content or an existing local hub item.',
        'LOCAL_SKILL_HUB_REMOTE_INSTALL_UNAVAILABLE',
        422,
      );
    }
    // Derive a stable, collision-free identity used as the on-disk directory,
    // the hub dedup key, and the `installed` detection key — never a shared
    // constant. Prefer an explicit name, then the matched hub item's own name,
    // then the skill's frontmatter name, then the source-URL slug.
    const name = resolveInstallSkillName({
      explicitName,
      existingName: existing?.name,
      content: explicitContent ?? existing?.content,
      displayName,
      sourceUrl,
    });
    const item: LocalSkillHubItem = {
      id: existing?.id ?? nextId(file.skills),
      name,
      display_name: displayName,
      description:
        readString(body['description']) ??
        existing?.description ??
        `Installed local skill ${displayName}`,
      content: explicitContent ?? existing?.content ?? '',
      source_url: sourceUrl,
      source_type: USER_SOURCE_TYPE,
      ...(publisherSourceType !== undefined ? { publisher_source_type: publisherSourceType } : {}),
      ...(resolvedCreatorInfo ? { creator_info: resolvedCreatorInfo } : {}),
      added: true,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    // Replace any prior record for this identity or source URL (also migrates a
    // legacy colliding `local-skill` row onto its real per-skill identity).
    file.skills = [
      ...file.skills.filter((skill) => skill.name !== name && skill.source_url !== sourceUrl),
      item,
    ];
    file.installed[name] = now;
    await this.writeFile(file);
    const skill = await writeInstalledSkill({
      dataDir: this.options.dataDir(),
      item,
      agentName,
      sourceType: USER_SOURCE_TYPE,
      files: installFiles,
    });
    return {
      ok: true,
      skill: {
        ...skill,
        ...(publisherSourceType !== undefined
          ? { publisher_source_type: publisherSourceType }
          : {}),
        ...(resolvedCreatorInfo ? { creator_info: resolvedCreatorInfo } : {}),
      },
    };
  }

  async preview(input: { url: string; ref?: string }): Promise<LocalSkillPreviewResp> {
    return toLocalSkillPreviewResp(
      await this.scanRemoteSkill(input.url, { ref: input.ref, promoteRepoKeys: true }),
    );
  }

  async uninstall(name: string): Promise<boolean> {
    const file = await this.readFile();
    const hadInstalled = file.installed[name] !== undefined;
    const now = this.nowMs();
    let changed = false;
    if (hadInstalled) {
      delete file.installed[name];
      changed = true;
    }
    file.skills = file.skills.map((skill) => {
      if (skill.name !== name || !skill.added) return skill;
      changed = true;
      return { ...skill, added: false, updated_at: now };
    });
    if (changed) await this.writeFile(file);
    return changed;
  }

  // Market installs are global. Key their identity and presentation metadata
  // by the exact global SKILL.md URI so a same-name agent/workspace winner
  // never inherits either the Market source marker or card metadata.
  async getInstalledGlobalMetadataByLocation(): Promise<
    ReadonlyMap<string, InstalledSkillHubMetadata>
  > {
    const file = await this.readFile();
    const dataDir = await realpath(this.options.dataDir()).catch(() => this.options.dataDir());
    return new Map(
      file.skills.flatMap((skill) => {
        if (!(file.installed[skill.name] !== undefined || skill.added)) {
          return [];
        }
        return [
          [
            skillLocationUri(join(dataDir, 'skills', skill.name, 'SKILL.md')),
            {
              ...(skill.display_name ? { displayName: skill.display_name } : {}),
              ...(skill.creator_info
                ? {
                    creatorInfo: {
                      userId: skill.creator_info.user_id,
                      userName: skill.creator_info.user_name,
                      avatarUrl: skill.creator_info.avatar_url,
                    },
                  }
                : {}),
              ...(skill.publisher_source_type !== undefined
                ? { publisherSourceType: skill.publisher_source_type }
                : {}),
            },
          ] as const,
        ];
      }),
    );
  }

  async getInstalledIdentities(): Promise<InstalledSkillHubIdentities> {
    const file = await this.readFile();
    const installed = file.skills.filter(
      (skill) => file.installed[skill.name] !== undefined || skill.added,
    );
    return {
      names: new Set(installed.map((skill) => normalizeIdentity(skill.name))),
      sourceUrls: new Set(
        installed.map((skill) => skill.source_url.trim()).filter((value) => value.length > 0),
      ),
    };
  }

  private async fetchRemoteSkillInstall(sourceUrl: string): Promise<{
    content: string;
    files: LocalSkillInstallFile[];
  }> {
    return selectRemoteSkillInstall(
      await this.scanRemoteSkill(sourceUrl, { promoteRepoKeys: false }),
      remoteSkillInstallHint(sourceUrl),
    );
  }

  private async scanRemoteSkill(
    sourceUrl: string,
    options: { ref?: string; promoteRepoKeys: boolean },
  ): Promise<LocalSkillArchiveScan> {
    const lookupKeys = remoteSkillArchiveCacheKeys(sourceUrl, undefined, options.ref);
    const cached = this.remoteSkillPreviewCache.read(lookupKeys);
    if (cached) return cached;

    const promise = scanRemoteSkillArchiveSource(sourceUrl, {
      fetch: this.options.fetch ?? fetch,
      ref: options.ref,
    });
    const writeKeys = options.promoteRepoKeys
      ? lookupKeys
      : [remoteSkillUrlCacheKey(sourceUrl, options.ref)];
    const initialEntry = this.remoteSkillPreviewCache.write(writeKeys, promise);
    promise
      .then((result) => {
        if (options.promoteRepoKeys) {
          this.remoteSkillPreviewCache.write(
            remoteSkillArchiveCacheKeys(sourceUrl, result.repoInfo, options.ref),
            Promise.resolve(result),
          );
        }
      })
      .catch(() => this.remoteSkillPreviewCache.deleteEntry(initialEntry));
    return promise;
  }

  private nowMs(): number {
    return this.options.nowMs?.() ?? Date.now();
  }

  private filePath(): string {
    return join(this.options.dataDir(), 'skill-hub.json');
  }

  private async readFile(): Promise<LocalSkillHubFile> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath(), 'utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { skills: [], installed: {} };
      }
      const record = parsed as { skills?: unknown; installed?: unknown };
      return {
        skills: normalizeItems(record.skills),
        installed: readNumberRecord(record.installed),
      };
    } catch {
      return { skills: [], installed: {} };
    }
  }

  private async writeFile(file: LocalSkillHubFile): Promise<void> {
    await mkdir(dirname(this.filePath()), { recursive: true });
    await writeFile(this.filePath(), `${JSON.stringify(file, null, 2)}\n`, 'utf8');
  }

  private async queryRemote(
    input: {
      keyword?: string;
      limit?: number;
      nextToken?: string;
      sourceType?: number;
      sortType?: number;
    },
    file: LocalSkillHubFile,
  ): Promise<
    { skill_list: LocalSkillHubListItem[]; has_more: boolean; next_token: string } | undefined
  > {
    if (!(this.options.remoteEnabled ?? isManagedRuntime)()) return undefined;

    const buildEnv = (this.options.buildEnv ?? getRuntimeBuildEnv)();
    const requestUrl = new URL(this.remoteUrl(undefined, buildEnv));
    requestUrl.searchParams.set('limit', String(input.limit && input.limit > 0 ? input.limit : 50));
    if (input.nextToken) requestUrl.searchParams.set('cursor', input.nextToken);
    requestUrl.searchParams.set('sort_type', String(normalizeRemoteSkillSortType(input.sortType)));
    if (input.sourceType !== undefined && input.sourceType !== SOURCE_TYPE_ALL) {
      requestUrl.searchParams.set('source_type', String(input.sourceType));
    }
    if (input.keyword?.trim()) requestUrl.searchParams.set('keyword', input.keyword.trim());
    const authContext = this.options.authContextGetter?.();
    const accessToken = authContext?.accessToken?.trim();
    const realUserID = authContext?.realUserID?.trim();
    if (accessToken && realUserID) requestUrl.searchParams.set('user_id', realUserID);

    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(requestUrl, {
        method: 'GET',
        headers: {
          'User-Agent': 'MiniMaxAgent',
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
          ...managedBackendRoutingHeaders(
            this.options.routingContextGetter?.(),
            this.options.buildEnv ? buildEnv : undefined,
          ),
        },
        signal: AbortSignal.timeout(REMOTE_SKILL_HUB_TIMEOUT_MS),
      });
    } catch {
      return undefined;
    }
    if (!response.ok) return undefined;

    let payload: RemoteSkillHubResponse;
    try {
      payload = (await response.json()) as RemoteSkillHubResponse;
    } catch {
      return undefined;
    }
    if (payload.base_resp && payload.base_resp.status_code !== 0) return undefined;

    // Detect "already added" by the installed identity OR the source URL. The
    // source-URL match keeps the market badge correct even if the remote hub's
    // `name` differs from the slug the skill was installed under (Meego
    // 7034556857).
    const installedSourceUrls = new Set(
      file.skills
        .filter((skill) => file.installed[skill.name] !== undefined)
        .map((skill) => skill.source_url)
        .filter((url) => url.length > 0),
    );
    const skillList = (payload.skill_list ?? []).flatMap((item) => {
      const mapped = mapRemoteSkillHubItem(item);
      if (!mapped) return [];
      const added =
        file.installed[mapped.name] !== undefined ||
        (mapped.source_url ? installedSourceUrls.has(mapped.source_url) : false);
      return [{ ...mapped, added }];
    });
    return {
      skill_list: skillList,
      has_more: payload.has_more ?? false,
      next_token: readString(payload.next_cursor) ?? '',
    };
  }

  private remoteUrl(region?: MavisRegion, buildEnv?: MavisBuildEnv): string {
    const resolvedRegion = region ?? (this.options.region ?? getRuntimeRegion)();
    const resolvedBuildEnv = buildEnv ?? (this.options.buildEnv ?? getRuntimeBuildEnv)();
    return SKILL_HUB_BASE[resolvedRegion][resolvedBuildEnv];
  }
}

export async function routeLocalSkillHubApi(input: {
  request: Request;
  method: string;
  parts: string[];
  url: URL;
  store: LocalSkillHubStore;
}): Promise<Response> {
  const tail = input.parts.slice(1);
  if (input.method === 'GET' && (tail.length === 0 || tail[0] === 'search')) {
    return json(
      await input.store.list({
        keyword:
          input.url.searchParams.get('keyword') ?? input.url.searchParams.get('q') ?? undefined,
        limit: readOptionalNumber(input.url.searchParams.get('limit')),
        nextToken: input.url.searchParams.get('next_token') ?? undefined,
        sourceType: readOptionalNumber(input.url.searchParams.get('source_type')),
        sortType: readOptionalNumber(input.url.searchParams.get('sort_type')),
      }),
    );
  }
  if (input.method === 'POST' && tail[0] === 'install') {
    try {
      return json(await input.store.install(await readJsonBody(input.request)), { status: 201 });
    } catch (err) {
      if (err instanceof LocalSkillHubInstallError) {
        return json({ ok: false, error: err.message, code: err.code }, { status: err.status });
      }
      throw err;
    }
  }
  return json(
    { error: `Local skill-hub route not found: /skill-hub/${tail.join('/')}` },
    { status: 404 },
  );
}

export async function installLocalSkillHubRequest(input: {
  dataDir: string;
  request: Request;
  nowMs?: () => number;
}): Promise<Response> {
  const store = new LocalSkillHubStore({
    dataDir: () => input.dataDir,
    nowMs: input.nowMs,
  });
  try {
    return json(await store.install(await readJsonBody(input.request)), { status: 201 });
  } catch (err) {
    if (err instanceof LocalSkillHubInstallError) {
      return json({ ok: false, error: err.message, code: err.code }, { status: err.status });
    }
    throw err;
  }
}

function normalizeItems(value: unknown): LocalSkillHubItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const record = raw as Record<string, unknown>;
    const name = readString(record['name']);
    if (!name) return [];
    const now = Date.now();
    const useCount = readOptionalNumber(record['use_count']);
    const publisherSourceType = normalizePublisherSourceType(record['publisher_source_type']);
    const creatorInfo = normalizeCreatorInfo(record['creator_info']);
    return [
      {
        id: readOptionalNumber(record['id']) ?? 0,
        name,
        ...(readString(record['display_name'])
          ? { display_name: readString(record['display_name']) }
          : {}),
        description: readString(record['description']) ?? '',
        content: readString(record['content']) ?? '',
        source_url: readString(record['source_url']) ?? '',
        source_type: readOptionalNumber(record['source_type']) ?? USER_SOURCE_TYPE,
        ...(publisherSourceType !== undefined
          ? { publisher_source_type: publisherSourceType }
          : {}),
        ...(useCount !== undefined ? { use_count: useCount } : {}),
        ...(creatorInfo ? { creator_info: creatorInfo } : {}),
        added: record['added'] === true,
        created_at: readOptionalNumber(record['created_at']) ?? now,
        updated_at: readOptionalNumber(record['updated_at']) ?? now,
      },
    ];
  });
}

function normalizePublisherSourceType(value: unknown): SkillSourceType | undefined {
  const sourceType = readOptionalNumber(value);
  return sourceType === OFFICIAL_SOURCE_TYPE || sourceType === USER_SOURCE_TYPE
    ? sourceType
    : undefined;
}

interface RemoteSkillHubItem {
  id?: number;
  name?: string;
  display_name?: string;
  description?: string;
  content?: string;
  prompt?: string;
  additional_content_url?: string;
  source_type?: number;
  type?: number;
  use_count?: number;
  source_url?: string;
  creator_info?: unknown;
  created_at?: number;
  updated_at?: number;
  create_at?: number;
  update_at?: number;
}

interface RemoteSkillHubResponse {
  skill_list?: RemoteSkillHubItem[];
  has_more?: boolean;
  next_cursor?: string;
  base_resp?: {
    status_code: number;
    status_msg?: string;
  };
}

function normalizeRemoteSkillSortType(value: number | undefined): 1 | 2 | 3 {
  if (value === 2 || value === 3) return value;
  return REMOTE_SKILL_SORT_TYPE_USE_COUNT;
}

function resolveRemotePublisherSourceType(remote: RemoteSkillHubItem): SkillSourceType | undefined {
  if (remote.source_type !== undefined) {
    return normalizePublisherSourceType(remote.source_type);
  }
  return readOptionalNumber(remote.type) === 1 ? OFFICIAL_SOURCE_TYPE : USER_SOURCE_TYPE;
}

function mapRemoteSkillHubItem(remote: RemoteSkillHubItem): LocalSkillHubListItem | undefined {
  const name = readString(remote.name);
  if (!name) return undefined;
  const now = Date.now();
  const useCount = readOptionalNumber(remote.use_count);
  const creatorInfo = normalizeCreatorInfo(remote.creator_info);
  const publisherSourceType = resolveRemotePublisherSourceType(remote);
  return {
    id: readOptionalNumber(remote.id) ?? 0,
    name,
    ...(readString(remote.display_name) ? { display_name: readString(remote.display_name) } : {}),
    description: readString(remote.description) ?? '',
    content: readString(remote.content) ?? readString(remote.prompt) ?? '',
    source_url: readString(remote.source_url) ?? readString(remote.additional_content_url) ?? '',
    ...(publisherSourceType !== undefined ? { source_type: publisherSourceType } : {}),
    ...(useCount !== undefined ? { use_count: useCount } : {}),
    ...(creatorInfo ? { creator_info: creatorInfo } : {}),
    // The cloud response is personalized for Web installs. Desktop owns a
    // separate local install state and computes it in queryRemote().
    added: false,
    created_at:
      readOptionalNumber(remote.created_at) ?? readOptionalNumber(remote.create_at) ?? now,
    updated_at:
      readOptionalNumber(remote.updated_at) ?? readOptionalNumber(remote.update_at) ?? now,
  };
}

function normalizeCreatorInfo(value: unknown): LocalSkillHubCreatorInfo | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const userId = readString(record['user_id']) ?? readString(record['userId']);
  const userName = readString(record['user_name']) ?? readString(record['userName']);
  const avatarUrl = readString(record['avatar_url']) ?? readString(record['avatarUrl']);
  if (!userId && !userName && !avatarUrl) return undefined;
  return {
    ...(userId ? { user_id: userId } : {}),
    ...(userName ? { user_name: userName } : {}),
    ...(avatarUrl ? { avatar_url: avatarUrl } : {}),
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function readOptionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readNumberRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, number] => typeof entry[1] === 'number',
    ),
  );
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//iu.test(value);
}

function skillLocationUri(filePath: string): string {
  return pathToFileURL(filePath).href.replace(/^file:/u, 'files:');
}

function validateAgentName(agentName: string | undefined): void {
  if (agentName === undefined || AGENT_NAME_PATTERN.test(agentName)) return;
  throw new LocalSkillHubInstallError(
    `Invalid agent name "${agentName}": must start with a lowercase letter and contain only lowercase letters, digits, underscores, or hyphens`,
    'LOCAL_SKILL_HUB_INVALID_AGENT_NAME',
    400,
  );
}

function nextId(items: LocalSkillHubItem[]): number {
  return items.reduce((max, item) => Math.max(max, item.id), 0) + 1;
}

function normalizeIdentity(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}
