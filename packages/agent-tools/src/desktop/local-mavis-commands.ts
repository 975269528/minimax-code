/**
 * Desktop mavis subcommand vocabulary: single source of truth.
 *
 * A separate module lets `builtin-defs.ts` (definitions) and `local-mavis.ts` (dispatcher) share
 * the command list without an import cycle. `local-mavis.ts` depends on `LocalMavisToolDef` in
 * builtin-defs.ts, so the vocabulary cannot live in the dispatcher.
 *
 * When adding a subcommand, update:
 * 1. `LOCAL_MAVIS_COMMANDS` here.
 * 2. `COMMAND_SCHEMAS` and `HANDLERS` in `local-mavis.ts`.
 * 3. The command list in `LocalMavisToolDef.schema.properties.command.description` in
 *   `builtin-defs.ts`.
 *
 * Type constraints in `local-mavis.ts` cause compilation to fail if 1 and 2 drift.
 */

export const LOCAL_MAVIS_COMMANDS = [
  'agent list',
  'agent get',
  'agent create',
  'agent update',
  'agent delete',
  'agent help',

  'cron list',
  'cron get',
  'cron resolve-model',
  'cron create',
  'cron self',
  'cron once',
  'cron update',
  'cron delete',
  'cron trigger',
  'cron sessions',
  'cron help',

  'session list',
  'session get',
  'session send',
  'session update',
  'session delete',
  'session messages',
  'session help',

  'mcp list',
  'mcp get',
  'mcp create',
  'mcp update',
  'mcp delete',
  'mcp help',
] as const;

export type LocalMavisCommandName = (typeof LOCAL_MAVIS_COMMANDS)[number];
