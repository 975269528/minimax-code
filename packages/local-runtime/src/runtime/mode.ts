export type LocalRuntimeMode = 'clean' | 'rollback';

export interface LocalRuntimeCapabilities {
  session: boolean;
  message: boolean;
  file: boolean;
  permission: boolean;
  queue: boolean;
  eventBus: boolean;
  goal: boolean;
  team: boolean;
  asr: boolean;
  skill: boolean;
  legacyImport: boolean;
  legacyRuntime: boolean;
  electronHost: boolean;
  cliEmbedded: boolean;
  diagnosticSidecar: boolean;
  questionnaireReply: boolean;
  permissionPrompt: boolean;
  elicitation: boolean;
}

export type LocalRuntimeInteractionCapability =
  | 'questionnaireReply'
  | 'permissionPrompt'
  | 'elicitation';

export type LocalRuntimeSurfaceStatus =
  | 'native'
  | 'legacy'
  | 'unsupported'
  | 'retired'
  | 'diagnostic';

export interface LocalRuntimeSurfaceCapability {
  status: LocalRuntimeSurfaceStatus;
  reason?: string;
}

export type LocalRuntimeSurfaceKey =
  | 'agent.core'
  | 'agent.cron'
  | 'agent.identity'
  | 'agent.im'
  | 'agent.permissionReply'
  | 'agent.questionnaire'
  | 'agent.usage'
  | 'browser.management'
  | 'browser.status'
  | 'channelBridge'
  | 'channelRoute'
  | 'communication.messages'
  | 'communication.peers'
  | 'communication.send'
  | 'config.apiKey'
  | 'config.core'
  | 'content'
  | 'cron'
  | 'diagnostics'
  | 'eventBus'
  | 'external.llmProviderDiscovery'
  | 'file'
  | 'goal'
  | 'hooks'
  | 'legacy.import'
  | 'legacy.runtime'
  | 'mcp'
  | 'models'
  | 'permission'
  | 'runtime'
  | 'session.core'
  | 'session.diff'
  | 'session.message'
  | 'session.queue'
  | 'session.resume'
  | 'session.usage'
  | 'skill.evolve'
  | 'skill.hub'
  | 'team'
  | 'usage';

export type LocalRuntimeSurfaceCapabilities = Record<
  LocalRuntimeSurfaceKey,
  LocalRuntimeSurfaceCapability
>;

export function resolveLocalRuntimeMode(
  env: { MAVIS_LOCAL_RUNTIME_CLEAN?: string } = process.env,
): LocalRuntimeMode {
  void env;
  return 'clean';
}

export function isCleanLocalRuntimeMode(mode = resolveLocalRuntimeMode()): boolean {
  return mode === 'clean';
}

export function buildLocalRuntimeCapabilities(
  mode: LocalRuntimeMode,
  overrides: Partial<LocalRuntimeCapabilities> = {},
): LocalRuntimeCapabilities {
  void mode;
  return {
    session: true,
    message: true,
    file: true,
    permission: true,
    queue: true,
    eventBus: true,
    goal: true,
    team: true,
    asr: false,
    skill: true,
    legacyImport: true,
    legacyRuntime: false,
    electronHost: false,
    cliEmbedded: false,
    diagnosticSidecar: false,
    questionnaireReply: true,
    permissionPrompt: true,
    elicitation: true,
    ...overrides,
  };
}

export function buildLocalRuntimeSurfaceCapabilities(
  mode: LocalRuntimeMode,
): LocalRuntimeSurfaceCapabilities {
  void mode;
  const retiredLegacyRuntime = {
    status: 'retired' as const,
    reason: 'Executable legacy runtime rollback has been retired from product surfaces.',
  };
  return {
    'agent.core': { status: 'native' },
    'agent.cron': {
      status: 'native',
      reason: 'Agent cron routes are backed by local-runtime cron host ports.',
    },
    'agent.identity': { status: 'native' },
    'agent.im': { status: 'native' },
    'agent.permissionReply': {
      status: 'native',
      reason:
        'Agent permission/question reply routes share the native local-runtime permission request bus.',
    },
    'agent.questionnaire': {
      status: 'native',
      reason:
        'Questionnaire is backed by DesktopService APIs and the native ask_user runtime tool.',
    },
    'agent.usage': {
      status: 'native',
      reason: 'Agent usage is projected from native local-runtime token usage records.',
    },
    'browser.management': {
      status: 'native',
      reason: 'Browser management routes are backed by the native local-runtime browser broker.',
    },
    'browser.status': { status: 'native' },
    channelBridge: {
      status: 'native',
      reason:
        'Channel bridge infrastructure routes, bindings, lane queues, and native inbound slash commands are available.',
    },
    channelRoute: { status: 'native' },
    'communication.messages': {
      status: 'native',
      reason: 'Communication history is derived from native local-runtime session messages.',
    },
    'communication.peers': { status: 'native' },
    'communication.send': { status: 'native' },
    'config.apiKey': {
      status: 'native',
      reason: 'Local runtime API key mutation updates provider config through the config store.',
    },
    'config.core': { status: 'native' },
    content: { status: 'native' },
    cron: {
      status: 'native',
      reason: 'Cron routes are backed by local-runtime cron host ports.',
    },
    diagnostics: {
      status: 'native',
      reason:
        'Diagnostic bundle upload routes dispatch through local-runtime host diagnostics ports.',
    },
    eventBus: { status: 'native' },
    'external.llmProviderDiscovery': { status: 'native' },
    file: { status: 'native' },
    goal: { status: 'native' },
    hooks: {
      status: 'retired',
      reason: 'Standalone user hooks are no longer supported. Custom hooks belong to Plugins.',
    },
    'legacy.import': { status: 'native' },
    'legacy.runtime': {
      ...retiredLegacyRuntime,
    },
    mcp: {
      status: 'native',
      reason: 'MCP registry, route handling, tools cache, and RuntimeTool injection are native.',
    },
    models: { status: 'native' },
    permission: { status: 'native' },
    runtime: { status: 'native' },
    'session.core': { status: 'native' },
    'session.diff': {
      status: 'native',
      reason:
        'Session diff and turn-diff are captured through native local-runtime turn artifacts.',
    },
    'session.message': { status: 'native' },
    'session.queue': { status: 'native' },
    'session.resume': { status: 'native' },
    'session.usage': {
      status: 'native',
      reason: 'Session usage is projected from native local-runtime token usage records.',
    },
    'skill.evolve': { status: 'native' },
    'skill.hub': {
      status: 'native',
      reason: 'Skill hub search/install is backed by the native local-runtime skill hub store.',
    },
    team: { status: 'native' },
    usage: {
      status: 'native',
      reason: 'Global usage is projected from native local-runtime token usage records.',
    },
  };
}

export function localRuntimeSurfaceSupportsEmbeddedCli(
  surface: LocalRuntimeSurfaceCapability | undefined,
): boolean {
  return surface?.status === 'native' || surface?.status === 'diagnostic';
}

export function resolveLocalRuntimeSurfaceForPath(
  method: string,
  pathname: string,
): LocalRuntimeSurfaceKey | undefined {
  const verb = method.toUpperCase();
  const path = normalizeRuntimeApiPath(pathname);
  const segments = path.split('/').filter(Boolean);
  if (path === '/health') return verb === 'GET' ? 'runtime' : undefined;
  if (path === '/api/version' || path === '/api/update') return 'runtime';
  if (path === '/api/events') return verb === 'GET' ? 'eventBus' : undefined;
  if (path === '/api/runtime' || path.startsWith('/api/runtime/')) {
    return verb === 'GET' ? 'runtime' : undefined;
  }
  if (path === '/api/content') return verb === 'POST' ? 'content' : undefined;
  if (path === '/api/config') return 'config.core';
  if (path === '/api/config/api-key') return 'config.apiKey';
  if (path.startsWith('/api/config/')) return 'config.core';
  if (path === '/api/models' || path.startsWith('/api/models/')) return 'models';
  if (path === '/api/external/llm-provider-discovery') {
    return verb === 'GET' ? 'external.llmProviderDiscovery' : undefined;
  }
  if (path === '/api/permission' || path.startsWith('/api/permission/')) return 'permission';
  if (path === '/api/goal' || path.startsWith('/api/goal/')) return 'goal';
  if (path === '/api/hooks' || path.startsWith('/api/hooks/')) return 'hooks';
  if (path === '/api/mcp' || path.startsWith('/api/mcp/')) return 'mcp';
  if (path === '/api/team' || path.startsWith('/api/team/')) return 'team';
  if (path === '/api/file' || path.startsWith('/api/file/')) return 'file';
  if (path === '/api/fs' || path.startsWith('/api/fs/')) return 'file';
  if (path === '/api/diagnostics' || path.startsWith('/api/diagnostics/')) return 'diagnostics';
  if (path === '/api/preferences' || path.startsWith('/api/preferences/')) return undefined;
  if (path === '/api/channel-route' || path.startsWith('/api/channel-route/'))
    return 'channelRoute';
  if (path === '/channel-route' || path.startsWith('/channel-route/')) return 'channelRoute';
  if (path === '/api/channel-bridge' || path.startsWith('/api/channel-bridge/')) {
    return 'channelBridge';
  }
  if (path === '/api/im-bridge' || path.startsWith('/api/im-bridge/')) return 'channelBridge';
  if (path === '/api/browser/status') return verb === 'GET' ? 'browser.status' : undefined;
  if (path === '/api/browser/install-info' || path === '/api/browser/profiles') {
    return verb === 'GET' ? 'browser.status' : undefined;
  }
  if (path === '/api/browser' || path.startsWith('/api/browser/')) return 'browser.management';
  if (path === '/api/communication/send') return verb === 'POST' ? 'communication.send' : undefined;
  if (path === '/api/communication/peers')
    return verb === 'GET' ? 'communication.peers' : undefined;
  if (path === '/api/communication/messages') {
    return verb === 'GET' ? 'communication.messages' : undefined;
  }
  if (path === '/api/communication' || path.startsWith('/api/communication/')) {
    return 'communication.messages';
  }
  if (path === '/api/cron' || path.startsWith('/api/cron/')) return 'cron';
  if (path === '/api/skill-hub' || path.startsWith('/api/skill-hub/')) return 'skill.hub';
  if (path === '/api/skill-evolve' || path.startsWith('/api/skill-evolve/')) return 'skill.evolve';
  if (path === '/api/agent') return 'agent.core';
  if (path.startsWith('/api/agent/')) {
    const tail = segments.slice(3).join('/');
    if (segments[2] === 'session') return 'agent.core';
    if (!tail) return 'agent.core';
    if (tail === 'session' || tail === 'session/root' || tail === 'session/tree') {
      return 'agent.core';
    }
    if (tail === 'identity' || tail === 'identity/avatar' || tail === 'avatar') {
      return 'agent.identity';
    }
    if (tail === 'im') return 'agent.im';
    if (tail === 'usage') return 'agent.usage';
    if (/^(permission|question)\/[^/]+\/(reply|reject)$/.test(tail)) {
      return 'agent.permissionReply';
    }
    if (tail === 'cron' || tail.startsWith('cron/')) return 'agent.cron';
    if (tail.endsWith('/request-compaction')) return 'agent.core';
    return 'agent.core';
  }
  if (path === '/api/session/foreground') return 'session.core';
  if (path.startsWith('/api/session/')) {
    const tail = segments.slice(3).join('/');
    if (!tail || tail === 'archive' || tail === 'compress' || tail === 'abort') {
      return 'session.core';
    }
    if (tail === 'message') return 'session.message';
    if (tail === 'resume') return 'session.resume';
    if (tail === 'queue' || tail.startsWith('queue/')) return 'session.queue';
    if (tail === 'diff' || tail === 'turn-diff' || tail.startsWith('turn-diff/')) {
      return 'session.diff';
    }
    if (tail === 'usage') return 'session.usage';
    if (tail === 'peek-context') return 'session.core';
    return 'session.core';
  }
  if (path === '/api/usage' || path.startsWith('/api/usage/')) return 'usage';
  return undefined;
}

export function legacyRuntimeEnabledForMode(
  mode: LocalRuntimeMode,
  explicitEnabled?: boolean,
): boolean {
  return mode === 'rollback' && explicitEnabled === true;
}

function normalizeRuntimeApiPath(pathname: string): string {
  const path = pathname.split('?')[0]?.replace(/\/+$/, '') || '/';
  if (path.startsWith('/mavis/api/')) return `/api/${path.slice('/mavis/api/'.length)}`;
  if (path === '/mavis/api') return '/api';
  if (path.startsWith('/mavis/')) return path.slice('/mavis'.length) || '/';
  return path;
}
