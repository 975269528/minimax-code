import type { MetricsClient } from '../common/metrics.js';
import type { LocalRuntimeConfig } from '../config/types.js';
import { isCuModeAvailable } from '../cu/gate.js';
import { LocalSkillHubInstallError, type LocalSkillHubStore } from './hub-api.js';

export function createRuntimeSkillBetaFlags(configGetter: () => LocalRuntimeConfig) {
  return (cuModeActive?: boolean): Readonly<Record<string, boolean | undefined>> => {
    const configured = (configGetter().beta ?? {}) as Record<string, boolean | undefined>;
    return {
      ...configured,
      cuMode: cuModeActive ?? isCuModeAvailable(configured['cuMode']),
    };
  };
}

export function requireSkillHub(skillHubStore: LocalSkillHubStore | undefined): LocalSkillHubStore {
  if (!skillHubStore) {
    throw new LocalSkillHubInstallError(
      'Desktop skill hub store is not configured',
      'SKILL_HUB_UNAVAILABLE',
      503,
    );
  }
  return skillHubStore;
}

export function createCatalogDiagnostics(metricsClient: MetricsClient | undefined): {
  readonly reportCatalogOverflowOnce: (
    sessionId: string | undefined,
    overflowType: 'soft' | 'hard',
  ) => void;
  readonly reportCatalogDescriptionCapOnce: (sessionId: string | undefined) => void;
} {
  const reportedCatalogOverflowSessionIds = new Set<string>();
  const reportedCatalogDescriptionCapSessionIds = new Set<string>();
  return {
    reportCatalogOverflowOnce(sessionId, overflowType) {
      if (!metricsClient || !sessionId || reportedCatalogOverflowSessionIds.has(sessionId)) return;
      reportedCatalogOverflowSessionIds.add(sessionId);
      metricsClient.counter('skill_catalog_overflow_observed_total', 1, { overflowType });
    },
    reportCatalogDescriptionCapOnce(sessionId) {
      if (!metricsClient || !sessionId || reportedCatalogDescriptionCapSessionIds.has(sessionId)) {
        return;
      }
      reportedCatalogDescriptionCapSessionIds.add(sessionId);
      metricsClient.counter('skill_catalog_description_cap_observed_total', 1);
    },
  };
}
