import type { LocalRuntimeCapabilities } from '../runtime/mode.js';
import {
  createHostedAgentCapabilities,
  type HostedAgentCapabilities,
  type HostedAgentCapabilitiesHost,
} from './hosted-agent-capabilities.js';

/**
 * Embedded command-line owners run a v2 Runtime without a Scheduler, so Cron,
 * memory and CU are unavailable there. This is the single source of truth for
 * "this host is a restricted command-line runtime" — reused by the reminder
 * pipeline so prompt guidance cannot drift from the capability matrix.
 */
export function isCliRestrictedRuntime(
  runtimeOwnerKind: string,
  cliEmbedded: LocalRuntimeCapabilities['cliEmbedded'],
): boolean {
  return (runtimeOwnerKind === 'cli' || runtimeOwnerKind === 'tui') && cliEmbedded === true;
}

export function createHostedCapabilities(
  host: HostedAgentCapabilitiesHost,
  runtimeOwnerKind: string,
  cliEmbedded: LocalRuntimeCapabilities['cliEmbedded'],
  capabilityProfile?: 'cli',
): HostedAgentCapabilities {
  const cliRuntime = isCliRestrictedRuntime(runtimeOwnerKind, cliEmbedded);
  return createHostedAgentCapabilities(
    host,
    cliRuntime
      ? {
          disableMemory: true,
          disableCron: true,
          disableComputerUse: true,
          ...(capabilityProfile === 'cli'
            ? {
                disableMavis: true,
                disabledBuiltinSkillNames: ['mavis-doctor', 'plugin-creator'] as const,
                resumeCodexAvailable: true,
              }
            : {}),
        }
      : undefined,
  );
}
