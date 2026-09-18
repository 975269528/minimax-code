import {
  resolveTaskTarget,
  type AgentReferenceResolver,
  type LocalTaskTargetFacts,
} from '../agent/port.js';
import {
  SUBAGENT_TELEMETRY_EVENT,
  emitSubagentTelemetry,
  inferNameResolutionSource,
  telemetryErrorCode,
} from '../agent/subagent-telemetry.js';
import type { ModuleMetricsReporter } from '../common/metrics.js';

export interface LocalTaskAgentResolverHost {
  agentResolver: AgentReferenceResolver;
  metrics?: ModuleMetricsReporter;
  emitBusEvent?: (type: string, payload: Record<string, unknown>) => void;
}

export async function resolveLocalTaskAgentTarget(
  host: LocalTaskAgentResolverHost,
  agentName: string | undefined,
): Promise<LocalTaskTargetFacts | undefined> {
  if (!agentName) return undefined;
  const requested = agentName.trim();
  if (!requested) return undefined;

  let source = inferNameResolutionSource(requested);
  try {
    const resolved = await resolveTaskTarget(host.agentResolver, requested);
    source = inferNameResolutionSource(requested, resolved.resolvedAgentName);
    emitSubagentTelemetry(host, SUBAGENT_TELEMETRY_EVENT.resolve, { source, success: true });
    return resolved;
  } catch (error) {
    emitSubagentTelemetry(host, SUBAGENT_TELEMETRY_EVENT.resolve, {
      source,
      success: false,
      ...(telemetryErrorCode(error) ? { error_code: telemetryErrorCode(error)! } : {}),
    });
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      ((error as { code?: unknown }).code === 'UNKNOWN_AGENT_NAME' ||
        (error as { code?: unknown }).code === 'AGENT_NOT_FOUND')
    ) {
      return undefined;
    }
    throw error;
  }
}

export async function resolveLocalTaskAgentName(
  host: LocalTaskAgentResolverHost,
  agentName: string | undefined,
): Promise<string | undefined> {
  return (await resolveLocalTaskAgentTarget(host, agentName))?.resolvedAgentName;
}
