import type { ChannelPlatform, SessionStrategy } from './route-api.js';
import { requiredString } from './im-connection-store-data.js';
import {
  LocalImConnectionError,
  type LocalImConnection,
  type LocalImPhysicalBinding,
} from './im-connection-types.js';

export interface LegacyImRoute {
  readonly key: string;
  /** `lark` is accepted only from legacy route data and immediately normalized. */
  readonly platform: ChannelPlatform | 'lark';
  readonly clientName: string;
  readonly agentName: string;
  readonly projectKey: string;
  /** Empty only for a credential-only migration that must create its Session lazily. */
  readonly sessionId: string;
  /** Original legacy binding intent. Only `root` / `main` may follow an Agent Root pointer. */
  readonly strategy?: SessionStrategy;
  /**
   * The opaque cursor recorded by a legacy `root` / `main` binding before the
   * host resolved the current active Root. It is receipt-repair evidence only.
   */
  readonly legacyRootSessionId?: string;
  /** The Project recorded beside {@link legacyRootSessionId}; likewise repair-only evidence. */
  readonly legacyRootProjectKey?: string;
  readonly emptyCursor?: boolean;
  /**
   * Set only after the host verified this exact Agent's historical Root
   * Session and frozen routing snapshot. It permits a narrow repair of a
   * previous automatic `default` migration receipt.
   */
  readonly trustedRootSessionId?: string;
  readonly updatedAt: number;
}

type NormalizedLegacyImRoute = Omit<LegacyImRoute, 'platform'> & {
  readonly platform: ChannelPlatform;
};

export type LegacyImMigrationSkipCode =
  | 'CHANNEL_IM_LEGACY_ROUTE_RECEIPT_REPLAY'
  | 'CHANNEL_IM_LEGACY_ROUTE_INVALID'
  | 'CHANNEL_IM_LEGACY_ROUTE_SUPERSEDED'
  | 'CHANNEL_IM_LEGACY_ROUTE_GROUP_CONFLICT'
  | 'CHANNEL_IM_LEGACY_ROUTE_CURSOR_CONFLICT'
  | 'CHANNEL_IM_LEGACY_ROUTE_PROJECT_REPAIR_UNPROVEN'
  | 'CHANNEL_IM_LEGACY_ROUTE_PROJECT_REPAIR_CONFLICT';

export interface LegacyImMigrationSkip {
  readonly code: LegacyImMigrationSkipCode;
  readonly keys: readonly string[];
}

export interface MigrateLegacyImConnectionsInput {
  readonly legacyRoutes: readonly LegacyImRoute[];
  /** Receipt keys already persisted by an extant physical Binding. */
  readonly preSkippedRouteKeys?: ReadonlySet<string>;
  readonly isUsableSession: (input: {
    agentName: string;
    projectKey: string;
    sessionId: string;
  }) => Promise<boolean>;
  /** Returns a local-degrade reason when current V2 state is authoritative. */
  readonly shouldSkipRoute?: (
    route: LegacyImRoute,
  ) => Promise<LegacyImMigrationSkipCode | undefined>;
  readonly onSkipped?: (skip: LegacyImMigrationSkip) => void;
  readonly findConnection: (
    agentName: string,
    channel: ChannelPlatform,
  ) => Promise<LocalImConnection | undefined>;
  readonly prepareConnection: (input: {
    agentName: string;
    channel: ChannelPlatform;
    projectKey: string | null;
    resolvedProjectKey: string;
    pendingLegacyRouteKeys?: readonly string[];
  }) => Promise<LocalImConnection>;
  readonly bindConnection: (input: {
    connectionId: string;
    clientName: string;
    currentSessionId?: string;
    emptyCursor?: boolean;
    migratedLegacyRouteKeys: readonly string[];
    migration: true;
  }) => Promise<LocalImPhysicalBinding>;
}

/**
 * One-version startup migration: reads legacy route rows but never mutates
 * them. Invalid or ambiguous legacy rows stay readable through the old route
 * fallback and cannot stop unrelated platform restoration.
 */
export async function migrateLegacyImConnections(
  input: MigrateLegacyImConnectionsInput,
): Promise<void> {
  const report = (code: LegacyImMigrationSkipCode, keys: readonly string[]) => {
    if (keys.length > 0) input.onSkipped?.({ code, keys: [...new Set(keys)].sort() });
  };
  const normalized: NormalizedLegacyImRoute[] = [];
  for (const route of input.legacyRoutes) {
    const rawKey = typeof route.key === 'string' ? route.key.trim() : '';
    if (rawKey && input.preSkippedRouteKeys?.has(rawKey)) {
      report('CHANNEL_IM_LEGACY_ROUTE_RECEIPT_REPLAY', [rawKey]);
      continue;
    }
    let normalizedRoute: NormalizedLegacyImRoute;
    try {
      normalizedRoute = normalizeRoute(route);
    } catch (error) {
      if (error instanceof LocalImConnectionError) {
        report('CHANNEL_IM_LEGACY_ROUTE_INVALID', rawKey ? [rawKey] : []);
        continue;
      }
      throw error;
    }
    // Do not fold host/state reads into the malformed-row catch above: a
    // storage or runtime-port failure remains a startup failure, not a row
    // that can be silently ignored.
    const skip = await input.shouldSkipRoute?.(normalizedRoute);
    if (skip) {
      report(skip, [normalizedRoute.key]);
      continue;
    }
    normalized.push(normalizedRoute);
  }

  const groups = new Map<string, NormalizedLegacyImRoute[]>();
  for (const route of normalized) {
    const key = `${route.agentName}\u0000${route.platform}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(route);
    groups.set(key, bucket);
  }

  const plans: Array<{
    route: NormalizedLegacyImRoute;
    migratedLegacyRouteKeys: readonly string[];
  }> = [];
  for (const routes of groups.values()) {
    const usable: NormalizedLegacyImRoute[] = [];
    for (const route of routes) {
      if (
        route.emptyCursor ||
        (await input.isUsableSession({
          agentName: route.agentName,
          projectKey: route.projectKey,
          sessionId: route.sessionId,
        }))
      ) {
        usable.push(route);
      } else {
        // Keep the original opaque row, but do not let an obsolete cursor or
        // owner poison a healthy route in the same historical profile.
        report('CHANNEL_IM_LEGACY_ROUTE_INVALID', [route.key]);
      }
    }
    if (usable.length === 0) continue;
    const keys = usable.map((route) => route.key);
    if (
      new Set(usable.map((route) => route.clientName)).size > 1 ||
      new Set(usable.map((route) => route.projectKey)).size > 1
    ) {
      report('CHANNEL_IM_LEGACY_ROUTE_GROUP_CONFLICT', keys);
      continue;
    }
    const cursorIds = new Set(
      usable.filter((route) => !route.emptyCursor).map((route) => route.sessionId),
    );
    if (cursorIds.size > 1) {
      report('CHANNEL_IM_LEGACY_ROUTE_CURSOR_CONFLICT', keys);
      continue;
    }
    const chosen = usable.sort(
      (left, right) =>
        (left.emptyCursor === true ? 1 : 0) - (right.emptyCursor === true ? 1 : 0) ||
        left.key.localeCompare(right.key),
    )[0];
    if (!chosen) continue;
    plans.push({
      route: chosen,
      migratedLegacyRouteKeys: usable
        .filter((route) => route.emptyCursor || route.sessionId === chosen.sessionId)
        .map((route) => route.key)
        .sort((left, right) => left.localeCompare(right)),
    });
  }

  const plansByConversation = new Map<string, typeof plans>();
  for (const plan of plans) {
    const key = `${plan.route.agentName}\u0000${plan.route.projectKey}`;
    const bucket = plansByConversation.get(key) ?? [];
    bucket.push(plan);
    plansByConversation.set(key, bucket);
  }
  const conflictedPlans = new Set<(typeof plans)[number]>();
  for (const plansForConversation of plansByConversation.values()) {
    const cursorIds = new Set(
      plansForConversation
        .filter((plan) => !plan.route.emptyCursor)
        .map((plan) => plan.route.sessionId),
    );
    if (cursorIds.size <= 1) continue;
    for (const plan of plansForConversation) conflictedPlans.add(plan);
    report(
      'CHANNEL_IM_LEGACY_ROUTE_CURSOR_CONFLICT',
      plansForConversation.flatMap((plan) => plan.migratedLegacyRouteKeys),
    );
  }

  for (const plan of plans) {
    if (conflictedPlans.has(plan)) continue;
    const { route, migratedLegacyRouteKeys } = plan;
    try {
      const connection =
        (await input.findConnection(route.agentName, route.platform)) ??
        (await input.prepareConnection({
          agentName: route.agentName,
          channel: route.platform,
          projectKey: route.projectKey === 'default' ? null : route.projectKey,
          resolvedProjectKey: route.projectKey,
          pendingLegacyRouteKeys: migratedLegacyRouteKeys,
        }));
      await input.bindConnection({
        connectionId: connection.connectionId,
        clientName: route.clientName,
        ...(route.emptyCursor ? { emptyCursor: true } : { currentSessionId: route.sessionId }),
        migratedLegacyRouteKeys,
        migration: true,
      });
    } catch (error) {
      if (isSupersededMigrationError(error)) {
        report('CHANNEL_IM_LEGACY_ROUTE_SUPERSEDED', migratedLegacyRouteKeys);
        continue;
      }
      throw error;
    }
  }
}

function normalizeRoute(route: LegacyImRoute): NormalizedLegacyImRoute {
  const key = requiredString(route.key, 'legacy route key');
  const emptyCursor = route.emptyCursor === true;
  const sessionId = emptyCursor
    ? String(route.sessionId ?? '').trim()
    : requiredString(route.sessionId, 'legacy sessionId');
  if (emptyCursor && sessionId) {
    throw new LocalImConnectionError(
      400,
      'CHANNEL_CONNECTION_MIGRATION_INVALID',
      'An empty legacy cursor cannot carry a Session.',
    );
  }
  return {
    ...route,
    key,
    platform: normalizeLegacyChannel(route.platform),
    clientName: requiredString(route.clientName, 'legacy clientName'),
    agentName: requiredString(route.agentName, 'legacy agentName'),
    projectKey: requiredString(route.projectKey, 'legacy projectKey'),
    sessionId,
    ...(emptyCursor ? { emptyCursor: true } : {}),
  };
}

function normalizeLegacyChannel(value: ChannelPlatform | 'lark'): ChannelPlatform {
  if (value === 'lark') return 'feishu';
  if (value === 'feishu' || value === 'telegram' || value === 'wechat') return value;
  throw new LocalImConnectionError(
    400,
    'CHANNEL_CONNECTION_MIGRATION_INVALID',
    'Legacy Channel route has an unsupported channel.',
  );
}

function isSupersededMigrationError(error: unknown): boolean {
  if (!(error instanceof LocalImConnectionError)) return false;
  return (
    error.code === 'CHANNEL_CONNECTION_MIGRATION_CONFLICT' ||
    error.code === 'CHANNEL_CONNECTION_ALREADY_BOUND' ||
    error.code === 'CHANNEL_EXTERNAL_ALREADY_BOUND' ||
    error.code === 'CHANNEL_CONNECTION_BOUND_IMMUTABLE' ||
    error.code === 'CHANNEL_CONNECTION_DUPLICATE'
  );
}
