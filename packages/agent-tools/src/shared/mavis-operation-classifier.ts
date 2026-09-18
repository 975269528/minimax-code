/**
 * Operation classifier shared by desktop / cloud mavis.
 *
 * Command normalization in both dispatchers must exactly match observability operation labels;
 * otherwise working commands fall into Grafana's unknown bucket. Both dispatchers and the
 * classifier therefore reuse `normalizeMavisCommand`.
 */

import type { ToolOperationClassifier } from '@mavis/agent-core/tools';

export function normalizeMavisCommand(rawCommand: string): string {
  const tokens = rawCommand.trim().split(/\s+/).filter(Boolean);
  const aliased = tokens.map((token) => (token === '-h' || token === '--help' ? 'help' : token));
  return aliased.join(' ');
}

export function createMavisOperationClassifier(
  allowedValues: readonly string[],
): ToolOperationClassifier {
  const allowed = new Set(allowedValues);
  return {
    allowedValues,
    classify(args) {
      if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
      const rawCommand = (args as { command?: unknown }).command;
      if (typeof rawCommand !== 'string') return undefined;
      const command = normalizeMavisCommand(rawCommand);
      return allowed.has(command) ? command : undefined;
    },
  };
}
