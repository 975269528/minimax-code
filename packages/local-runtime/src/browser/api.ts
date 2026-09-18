import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { json, notFound, readJsonBody } from '../api/host-helpers.js';

interface LocalBrowserInstallInfo {
  installed: boolean;
  profile: string;
  dataDir: string;
  extensionId?: string;
  wrapperPath?: string;
  installedAt?: number;
  needsMigration?: boolean;
}

interface LocalBrowserClaim {
  session_id: string;
  session_kind: 'root' | 'worker';
  target: 'chrome';
  tab_ids: number[];
  created_at: number;
}

export interface LocalBrowserBrokerOptions {
  dataDir: () => string;
  nowMs?: () => number;
}

const LOCAL_BROWSER_EXTENSION_ID = 'local-runtime-browser-extension';

export class LocalBrowserBroker {
  constructor(private readonly options: LocalBrowserBrokerOptions) {}

  async status(): Promise<Record<string, unknown>> {
    const claims = await this.readClaims();
    return {
      profile: 'default',
      dataDir: this.options.dataDir(),
      brokerRunning: false,
      hostConnected: false,
      socketPath: '',
      claims,
    };
  }

  async installInfo(): Promise<LocalBrowserInstallInfo> {
    return (
      (await this.readInstallInfo()) ?? {
        installed: false,
        profile: 'default',
        dataDir: this.options.dataDir(),
      }
    );
  }

  async profiles(): Promise<Record<string, unknown>> {
    const info = await this.installInfo();
    return {
      currentProfile: 'default',
      profiles: [
        {
          profile: 'default',
          installed: info.installed,
          ...(info.extensionId ? { extensionId: info.extensionId } : {}),
          ...(info.installedAt ? { installedAt: info.installedAt } : {}),
        },
      ],
    };
  }

  async install(): Promise<Record<string, unknown>> {
    return {
      ok: false,
      profile: 'default',
      extensionId: LOCAL_BROWSER_EXTENSION_ID,
      error:
        'Local browser native-host installation is not available in the local-runtime fallback.',
      code: 'LOCAL_BROWSER_INSTALL_UNAVAILABLE',
    };
  }

  async uninstall(): Promise<Record<string, unknown>> {
    await rm(this.installInfoPath(), { force: true });
    return { ok: true, profile: 'default' };
  }

  async tools(): Promise<Record<string, unknown>> {
    return {
      tools: [
        {
          name: 'list_tabs',
          description: 'List open browser tabs when a native browser host is connected.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          requiresTab: false,
          targets: ['chrome'],
        },
        {
          name: 'open_url',
          description: 'Open a URL through the local browser broker when available.',
          inputSchema: {
            type: 'object',
            properties: { url: { type: 'string' } },
            required: ['url'],
            additionalProperties: false,
          },
          requiresTab: false,
          targets: ['chrome'],
        },
      ],
    };
  }

  async extensionPath(): Promise<Record<string, unknown>> {
    return {
      path: join(this.options.dataDir(), 'browser-extension'),
      exists: false,
      localRuntime: true,
    };
  }

  async revealExtension(): Promise<Record<string, unknown>> {
    return {
      opened: false,
      path: join(this.options.dataDir(), 'browser-extension'),
      command: '',
      localRuntime: true,
    };
  }

  async openExtensions(): Promise<Record<string, unknown>> {
    return {
      opened: false,
      command: '',
      args: [],
      localRuntime: true,
    };
  }

  async sessions(): Promise<Record<string, unknown>> {
    const claims = await this.readClaims();
    return { sessions: claims.active, detached: claims.detached, count: claims.active.length };
  }

  async claim(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const rawTarget = readString(body['target']);
    if (rawTarget === 'embedded') {
      return {
        ok: false,
        code: 'LOCAL_BROWSER_EMBEDDED_TARGET_UNAVAILABLE',
        error: 'Embedded browser is available only as a user-visible FilePanel preview.',
      };
    }
    const sessionId = readString(body['sessionId']) ?? readString(body['session_id']) ?? 'local';
    const tabId = readNumber(body['tabId']) ?? readNumber(body['tab_id']) ?? this.nowMs();
    const rawSessionKind = readString(body['sessionKind']) ?? readString(body['session_kind']);
    const sessionKind = rawSessionKind === 'worker' ? 'worker' : 'root';
    const claims = await this.readClaims();
    const next: LocalBrowserClaim = {
      session_id: sessionId,
      session_kind: sessionKind,
      target: 'chrome',
      tab_ids: [tabId],
      created_at: this.nowMs(),
    };
    claims.active = [...claims.active.filter((claim) => !claim.tab_ids.includes(tabId)), next];
    await this.writeClaims(claims);
    return { ok: true, claim: next, sessionId };
  }

  async release(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const sessionId = readString(body['sessionId']) ?? readString(body['session_id']);
    const tabId = readNumber(body['tabId']) ?? readNumber(body['tab_id']);
    const claims = await this.readClaims();
    const before = claims.active.length;
    claims.active = claims.active.filter((claim) => {
      if (sessionId && claim.session_id === sessionId) return false;
      if (tabId !== undefined && claim.tab_ids.includes(tabId)) return false;
      return true;
    });
    await this.writeClaims(claims);
    return { ok: true, released: before - claims.active.length };
  }

  private nowMs(): number {
    return this.options.nowMs?.() ?? Date.now();
  }

  private installInfoPath(): string {
    return join(this.options.dataDir(), 'browser-config.json');
  }

  private claimsPath(): string {
    return join(this.options.dataDir(), 'browser-claims.json');
  }

  private async readInstallInfo(): Promise<LocalBrowserInstallInfo | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.installInfoPath(), 'utf8')) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as LocalBrowserInstallInfo)
        : undefined;
    } catch {
      return undefined;
    }
  }

  private async readClaims(): Promise<{
    active: LocalBrowserClaim[];
    detached: LocalBrowserClaim[];
  }> {
    try {
      const parsed = JSON.parse(await readFile(this.claimsPath(), 'utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { active: [], detached: [] };
      }
      const record = parsed as { active?: unknown; detached?: unknown };
      return {
        active: normalizeClaims(record.active),
        detached: normalizeClaims(record.detached),
      };
    } catch {
      return { active: [], detached: [] };
    }
  }

  private async writeClaims(claims: {
    active: LocalBrowserClaim[];
    detached: LocalBrowserClaim[];
  }): Promise<void> {
    await mkdir(dirname(this.claimsPath()), { recursive: true });
    await writeFile(this.claimsPath(), `${JSON.stringify(claims, null, 2)}\n`, 'utf8');
  }
}

export async function routeLocalBrowserApi(input: {
  request: Request;
  method: string;
  parts: string[];
  broker: LocalBrowserBroker;
}): Promise<Response> {
  const tail = input.parts.slice(1).join('/');
  if (input.method === 'GET' && tail === 'status') return json(await input.broker.status());
  if (input.method === 'GET' && tail === 'install-info') {
    return json(await input.broker.installInfo());
  }
  if (input.method === 'GET' && tail === 'profiles') return json(await input.broker.profiles());
  if (input.method === 'POST' && tail === 'install') {
    return json(await input.broker.install(), { status: 503 });
  }
  if (input.method === 'POST' && tail === 'uninstall') return json(await input.broker.uninstall());
  if (input.method === 'GET' && tail === 'tools') return json(await input.broker.tools());
  if (input.method === 'GET' && tail === 'extension-path') {
    return json(await input.broker.extensionPath());
  }
  if (input.method === 'POST' && tail === 'reveal-extension') {
    return json(await input.broker.revealExtension());
  }
  if (input.method === 'POST' && tail === 'open-extensions') {
    return json(await input.broker.openExtensions());
  }
  if (input.method === 'GET' && tail === 'sessions') return json(await input.broker.sessions());
  if (input.method === 'POST' && tail === 'claim') {
    return json(await input.broker.claim(await readJsonBody(input.request)));
  }
  if (input.method === 'POST' && (tail === 'release' || tail === 'close')) {
    return json(await input.broker.release(await readJsonBody(input.request)));
  }
  return notFound(`/browser/${tail}`);
}

function normalizeClaims(value: unknown): LocalBrowserClaim[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const sessionId = readString(record['session_id']);
    if (!sessionId) return [];
    if (record['target'] === 'embedded') return [];
    return [
      {
        session_id: sessionId,
        session_kind: record['session_kind'] === 'worker' ? 'worker' : 'root',
        target: 'chrome',
        tab_ids: Array.isArray(record['tab_ids'])
          ? record['tab_ids'].filter((tab): tab is number => typeof tab === 'number')
          : [],
        created_at: readNumber(record['created_at']) ?? 0,
      },
    ];
  });
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
