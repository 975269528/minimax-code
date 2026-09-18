import { PluginSystemError } from '../../errors.js';

export interface GithubPluginSource {
  readonly repositoryUrl: string;
  readonly commitSha: string;
  readonly subPath?: string;
}

export async function resolveGitRepositorySource(
  sourceUrl: string,
  options: { fetchImpl: typeof fetch; signal?: AbortSignal },
): Promise<GithubPluginSource> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(sourceUrl.trim());
  } catch {
    fail('GIT_REPOSITORY_URL_INVALID', 'An HTTPS Git repository URL is required');
  }
  if (isGithubHost(parsedUrl.hostname)) {
    return resolveGithubPluginSource(sourceUrl, options.fetchImpl, options.signal);
  }
  const url = parseGitRepositoryUrl(sourceUrl);
  const commitSha = await resolveRemoteHead(url.toString(), options.signal);
  return { repositoryUrl: url.toString().replace(/\.git$/iu, ''), commitSha };
}

export function isGithubRepositoryUrl(value: string): boolean {
  try {
    return isGithubHost(new URL(value.trim()).hostname);
  } catch {
    return false;
  }
}

export function validateGitRepositorySource(source: GithubPluginSource): GithubPluginSource {
  const url = parseGitRepositoryUrl(source.repositoryUrl);
  const commitSha = source.commitSha.toLowerCase();
  if (!FULL_SHA.test(commitSha))
    fail('GIT_REPOSITORY_SOURCE_INVALID', 'commit_sha must be a full SHA');
  if (isGithubHost(url.hostname)) return validateGithubPluginSource(source);
  if (source.subPath !== undefined)
    return {
      repositoryUrl: url.toString().replace(/\.git$/iu, ''),
      commitSha,
      subPath: normalizeSubPath(source.subPath),
    };
  return { repositoryUrl: url.toString().replace(/\.git$/iu, ''), commitSha };
}

function parseGitRepositoryUrl(value: string): URL {
  if (value.length > 2_048) fail('GIT_REPOSITORY_URL_INVALID', 'Git repository URL is too long');
  const url = parseHttpsUrl(value);
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 2 || parts.some((part) => !/^[A-Za-z0-9_.~-]+$/u.test(part))) {
    fail('GIT_REPOSITORY_URL_INVALID', 'URL must identify a Git repository');
  }
  if (!parts.at(-1)?.endsWith('.git')) url.pathname = `${url.pathname}.git`;
  return url;
}

function parseHttpsUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    fail('GIT_REPOSITORY_URL_INVALID', 'An HTTPS Git repository URL is required');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  ) {
    fail(
      'GIT_REPOSITORY_URL_INVALID',
      'An HTTPS Git repository URL without credentials is required',
    );
  }
  return url;
}

function isGithubHost(hostname: string): boolean {
  return ['github.com', 'www.github.com'].includes(hostname.toLowerCase());
}

async function resolveRemoteHead(url: string, signal?: AbortSignal): Promise<string> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  try {
    const result = await run('git', ['ls-remote', '--symref', url, 'HEAD'], {
      timeout: TIMEOUT_MS,
      maxBuffer: 64 * 1024,
      signal,
      windowsHide: true,
    });
    const sha = result.stdout
      .split(/\r?\n/u)
      .map((line) => line.split(/\s+/u)[0])
      .find((value) => FULL_SHA.test(value ?? ''));
    if (!sha) fail('GIT_REPOSITORY_REF_NOT_FOUND', 'Git repository HEAD could not be resolved');
    return sha.toLowerCase();
  } catch (error) {
    if (error instanceof PluginSystemError) throw error;
    if (signal?.aborted) throw error;
    fail('GIT_REPOSITORY_UNAVAILABLE', 'Git repository could not be reached');
  }
}

interface GithubRepository {
  readonly owner: string;
  readonly repo: string;
}

interface GithubRequestContext {
  readonly fetchImpl: typeof fetch;
  readonly signal?: AbortSignal;
  apiUnavailable?: boolean;
  advertisedRefs?: Promise<ReadonlyMap<string, string>>;
}

const FULL_SHA = /^[a-f0-9]{40}$/u;
const COMMON_REFS = new Set(['main', 'master', 'dev', 'develop', 'trunk']);
const TIMEOUT_MS = 30_000;
const MAX_GIT_REFS_BYTES = 4 * 1024 * 1024;

async function resolveGithubPluginSource(
  sourceUrl: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<GithubPluginSource> {
  const parsed = parseGithubUrl(sourceUrl);
  const context = { fetchImpl, signal };
  if (!parsed.routeTail) {
    const commitSha = await readCommitSha(parsed.repository, 'HEAD', context);
    if (!commitSha) fail('GITHUB_REF_NOT_FOUND', 'GitHub default branch could not be resolved');
    return sourceOf(parsed.repository, commitSha, undefined);
  }
  const splits = orderedRefSplits(parsed.routeTail);
  if (!isCommonOrImmutableRef(parsed.routeTail[0])) {
    const advertised = await resolveFromAdvertisedRefs(
      parsed.repository,
      parsed.routeTail,
      splits,
      context,
    );
    if (advertised) return advertised;
  }
  for (const split of splits) {
    const ref = parsed.routeTail.slice(0, split).join('/');
    const commitSha = await readCommitSha(parsed.repository, ref, context);
    if (!commitSha) continue;
    const subPath = normalizeSubPath(parsed.routeTail.slice(split).join('/'));
    return sourceOf(parsed.repository, commitSha, subPath);
  }
  fail('GITHUB_REF_NOT_FOUND', 'GitHub branch or commit could not be resolved');
}

function isCommonOrImmutableRef(value: string | undefined): boolean {
  return COMMON_REFS.has(value ?? '') || FULL_SHA.test((value ?? '').toLowerCase());
}

async function resolveFromAdvertisedRefs(
  repository: GithubRepository,
  routeTail: readonly string[],
  splits: readonly number[],
  context: GithubRequestContext,
): Promise<GithubPluginSource | undefined> {
  try {
    context.advertisedRefs ??= loadAdvertisedRefs(repository, context);
    const refs = await context.advertisedRefs;
    for (const split of splits) {
      const ref = routeTail.slice(0, split).join('/');
      const commitSha = findAdvertisedRef(refs, ref);
      if (!commitSha) continue;
      return sourceOf(repository, commitSha, normalizeSubPath(routeTail.slice(split).join('/')));
    }
    fail('GITHUB_REF_NOT_FOUND', 'GitHub branch or commit could not be resolved');
  } catch (error) {
    if (!(error instanceof PluginSystemError) || error.code !== 'GITHUB_UNAVAILABLE') throw error;
    context.advertisedRefs = undefined;
  }
  return undefined;
}

export function validateGithubPluginSource(source: GithubPluginSource): GithubPluginSource {
  const parsed = parseGithubUrl(source.repositoryUrl);
  if (parsed.routeTail) fail('GITHUB_SOURCE_INVALID', 'repository_url must identify a repository');
  const commitSha = source.commitSha.toLowerCase();
  if (!FULL_SHA.test(commitSha)) fail('GITHUB_SOURCE_INVALID', 'commit_sha must be a full SHA');
  return sourceOf(parsed.repository, commitSha, normalizeSubPath(source.subPath));
}

export function githubArchiveUrl(source: GithubPluginSource): string {
  const parsed = parseGithubUrl(source.repositoryUrl);
  return `https://codeload.github.com/${parsed.repository.owner}/${parsed.repository.repo}/zip/${source.commitSha}`;
}

function parseGithubUrl(value: string): {
  repository: GithubRepository;
  routeTail?: string[];
} {
  if (value.length > 2_048) fail('GITHUB_URL_INVALID', 'GitHub URL is too long');
  const url = parsePublicGithubUrl(value);
  const parts = url.pathname.split('/').filter(Boolean).map(safeDecode);
  const repository = parseRepository(parts);
  return parseRepositoryRoute(repository, parts);
}

function parsePublicGithubUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    fail('GITHUB_URL_INVALID', 'A public GitHub HTTPS URL is required');
  }
  const hostAllowed = ['github.com', 'www.github.com'].includes(url.hostname.toLowerCase());
  const hasForbiddenComponent = Boolean(
    url.username || url.password || url.port || url.search || url.hash,
  );
  if (url.protocol !== 'https:' || !hostAllowed || hasForbiddenComponent) {
    fail('GITHUB_URL_INVALID', 'A public GitHub HTTPS URL is required');
  }
  return url;
}

function parseRepository(parts: readonly string[]): GithubRepository {
  if (parts.length < 2) fail('GITHUB_URL_INVALID', 'GitHub repository path is incomplete');
  const owner = parts[0];
  const repo = parts[1]?.replace(/\.git$/iu, '');
  if (!owner || !repo || !/^[A-Za-z0-9_.-]+$/u.test(owner) || !/^[A-Za-z0-9_.-]+$/u.test(repo)) {
    fail('GITHUB_URL_INVALID', 'GitHub repository path is invalid');
  }
  return { owner, repo };
}

function parseRepositoryRoute(
  repository: GithubRepository,
  parts: readonly string[],
): { repository: GithubRepository; routeTail?: string[] } {
  if (parts.length === 2) return { repository };
  if (parts[2] !== 'tree' || parts.length < 4) {
    fail('GITHUB_URL_INVALID', 'URL must identify a repository or repository directory');
  }
  const routeTail = parts.slice(3);
  if (routeTail.length > 32) fail('GITHUB_URL_INVALID', 'GitHub path has too many segments');
  return { repository, routeTail };
}

async function readCommitSha(
  repository: GithubRepository,
  ref: string,
  context: GithubRequestContext,
): Promise<string | undefined> {
  const immutableSha = normalizeFullSha(ref);
  if (immutableSha) return immutableSha;
  if (context.signal?.aborted) throw context.signal.reason;

  if (context.advertisedRefs) {
    const cached = await readCachedAdvertisedRef(ref, context);
    if (cached.checked) return cached.sha;
  }

  return readCommitShaFromApi(repository, ref, context);
}

async function readCommitShaFromApi(
  repository: GithubRepository,
  ref: string,
  context: GithubRequestContext,
): Promise<string | undefined> {
  try {
    const response = await githubGet(
      `https://api.github.com/repos/${repository.owner}/${repository.repo}/commits/${encodeURIComponent(ref)}`,
      context,
    );
    const sha = isRecord(response) ? response.sha : undefined;
    return typeof sha === 'string' ? normalizeFullSha(sha) : undefined;
  } catch (error) {
    if (!(error instanceof PluginSystemError)) throw error;
    if (error.code === 'GITHUB_NOT_FOUND') return undefined;
    if (error.code !== 'GITHUB_UNAVAILABLE') throw error;
    context.apiUnavailable = true;
    return readAdvertisedRef(repository, ref, context);
  }
}

function normalizeFullSha(ref: string): string | undefined {
  const normalized = ref.toLowerCase();
  return FULL_SHA.test(normalized) ? normalized : undefined;
}

interface CachedRefLookup {
  readonly checked: boolean;
  readonly sha?: string;
}

async function readCachedAdvertisedRef(
  ref: string,
  context: GithubRequestContext,
): Promise<CachedRefLookup> {
  if (!context.advertisedRefs) return { checked: false };
  const sha = findAdvertisedRef(await context.advertisedRefs, ref);
  if (sha || context.apiUnavailable) return { checked: true, sha };
  return { checked: false };
}

async function readAdvertisedRef(
  repository: GithubRepository,
  ref: string,
  context: GithubRequestContext,
): Promise<string | undefined> {
  context.advertisedRefs ??= loadAdvertisedRefs(repository, context);
  return findAdvertisedRef(await context.advertisedRefs, ref);
}

function findAdvertisedRef(refs: ReadonlyMap<string, string>, ref: string): string | undefined {
  if (ref === 'HEAD' || ref.startsWith('refs/')) return refs.get(ref);
  return refs.get(`refs/heads/${ref}`) ?? refs.get(`refs/tags/${ref}`);
}

async function loadAdvertisedRefs(
  repository: GithubRepository,
  context: GithubRequestContext,
): Promise<ReadonlyMap<string, string>> {
  const url = `https://github.com/${repository.owner}/${repository.repo}.git/info/refs?service=git-upload-pack`;
  let response: Response;
  try {
    response = await context.fetchImpl(url, {
      headers: {
        Accept: 'application/x-git-upload-pack-advertisement',
        'User-Agent': 'MiniMax-Code',
      },
      signal: requestSignal(context.signal, TIMEOUT_MS),
    });
  } catch (error) {
    if (context.signal?.aborted) throw error;
    fail('GITHUB_UNAVAILABLE', 'GitHub Git refs could not be reached');
  }
  if (response.status === 404) {
    fail('GITHUB_UNAVAILABLE', 'GitHub Git refs were not available');
  }
  if (!response.ok || !response.body) {
    fail('GITHUB_UNAVAILABLE', `GitHub Git refs returned ${response.status}`);
  }
  return parseGitAdvertisement(await readResponseBounded(response.body, context.signal));
}

async function readResponseBounded(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = body.getReader();
  try {
    let result = await reader.read();
    while (!result.done) {
      total += result.value.byteLength;
      if (total > MAX_GIT_REFS_BYTES) {
        await reader.cancel();
        fail('GITHUB_UNAVAILABLE', 'GitHub Git refs response is too large');
      }
      chunks.push(Buffer.from(result.value));
      result = await reader.read();
    }
  } catch (error) {
    if (signal?.aborted || error instanceof PluginSystemError) throw error;
    fail('GITHUB_UNAVAILABLE', 'GitHub Git refs response could not be read');
  }
  return Buffer.concat(chunks, total);
}

function parseGitAdvertisement(bytes: Buffer): ReadonlyMap<string, string> {
  const refs = new Map<string, string>();
  let offset = 0;
  while (offset < bytes.length) {
    const packet = readGitPacket(bytes, offset);
    offset = packet.nextOffset;
    if (packet.payload) addAdvertisedRef(refs, packet.payload);
  }
  return refs;
}

interface GitPacket {
  readonly nextOffset: number;
  readonly payload?: string;
}

function readGitPacket(bytes: Buffer, offset: number): GitPacket {
  if (offset + 4 > bytes.length) fail('GITHUB_UNAVAILABLE', 'GitHub Git refs are truncated');
  const lengthText = bytes.subarray(offset, offset + 4).toString('ascii');
  if (!/^[0-9a-f]{4}$/iu.test(lengthText)) {
    fail('GITHUB_UNAVAILABLE', 'GitHub Git refs are invalid');
  }
  const packetLength = Number.parseInt(lengthText, 16);
  const payloadOffset = offset + 4;
  if (packetLength === 0) return { nextOffset: payloadOffset };
  const nextOffset = offset + packetLength;
  if (packetLength < 4 || nextOffset > bytes.length) {
    fail('GITHUB_UNAVAILABLE', 'GitHub Git refs are truncated');
  }
  return {
    nextOffset,
    payload: bytes.subarray(payloadOffset, nextOffset).toString('utf8'),
  };
}

function addAdvertisedRef(refs: Map<string, string>, payload: string): void {
  const advertised = payload.split('\0', 1)[0]?.trimEnd() ?? '';
  const match = /^([0-9a-f]{40}) (\S+)$/u.exec(advertised);
  if (!match) return;
  const sha = match[1];
  const name = match[2];
  if (!sha || !name) return;
  if (name.endsWith('^{}')) {
    refs.set(name.slice(0, -3), sha);
    return;
  }
  if (!refs.has(name)) refs.set(name, sha);
}

async function githubGet(url: string, context: GithubRequestContext): Promise<unknown> {
  let response: Response;
  try {
    response = await context.fetchImpl(url, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'MiniMax-Code' },
      signal: requestSignal(context.signal, TIMEOUT_MS),
    });
  } catch (error) {
    if (context.signal?.aborted) throw error;
    fail('GITHUB_UNAVAILABLE', 'GitHub could not be reached');
  }
  if (response.status === 404) fail('GITHUB_NOT_FOUND', 'GitHub repository or ref was not found');
  if (!response.ok) fail('GITHUB_UNAVAILABLE', `GitHub returned ${response.status}`);
  try {
    return await response.json();
  } catch {
    fail('GITHUB_UNAVAILABLE', 'GitHub returned invalid JSON');
  }
}

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function sourceOf(
  repository: GithubRepository,
  commitSha: string,
  subPath: string | undefined,
): GithubPluginSource {
  return {
    repositoryUrl: `https://github.com/${repository.owner}/${repository.repo}`,
    commitSha,
    ...(subPath ? { subPath } : {}),
  };
}

function orderedRefSplits(parts: readonly string[]): number[] {
  const splits = Array.from({ length: parts.length }, (_value, index) => index + 1);
  if (isCommonOrImmutableRef(parts[0])) {
    return [1, ...splits.slice(1).reverse()];
  }
  return splits.reverse();
}

function normalizeSubPath(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  const segments = value.split('/');
  if (
    segments.some((part) => !part || part === '.' || part === '..' || part.includes('\\')) ||
    value.startsWith('/')
  ) {
    fail('GITHUB_SUB_PATH_INVALID', 'GitHub subdirectory is invalid');
  }
  return segments.join('/');
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    fail('GITHUB_URL_INVALID', 'GitHub URL contains invalid escaping');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(code: string, message: string): never {
  throw new PluginSystemError(code, message);
}
