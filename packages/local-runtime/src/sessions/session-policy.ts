import type { LocalSessionRecord } from './controller.js';

const LOCAL_DIRECT_TASK_PURPOSE_PREFIXES = ['local-task:', 'local-background-task:'] as const;

export function isLocalDirectTaskPurpose(purpose: string | undefined): boolean {
  return LOCAL_DIRECT_TASK_PURPOSE_PREFIXES.some((prefix) => purpose?.startsWith(prefix));
}

export function isLocalTaskWorkerPurpose(purpose: string | undefined): boolean {
  return isLocalDirectTaskPurpose(purpose) || purpose?.startsWith('team-plan:') === true;
}

export function isLocalChildWorkerSession(
  session: Pick<
    LocalSessionRecord,
    'sessionType' | 'parentSessionId' | 'visibility' | 'sessionKind' | 'purpose'
  >,
): boolean {
  if (!session.parentSessionId) return false;
  if (session.sessionKind === 'task') return true;
  if (session.sessionType !== 'branch' || session.visibility !== 'hidden') return false;
  // Existing Team workers may already carry the persisted 'conversation' default.
  // Match Session System's durable Task-purpose fallback; kind-less compatibility
  // callers additionally retain the old structural policy.
  return session.sessionKind === undefined || isLocalTaskWorkerPurpose(session.purpose?.trim());
}

/**
 * Default sidebar tree projection.
 *
 * Task workers remain hidden from flat/search/project projections, but their
 * known purpose makes them durable sidebar children after refresh. Other
 * hidden children and top-level/system sessions stay out of this projection.
 */
export function isLocalSidebarTreeSession(
  session: Pick<
    LocalSessionRecord,
    'sessionType' | 'parentSessionId' | 'visibility' | 'sessionKind' | 'purpose'
  >,
): boolean {
  return (
    session.visibility !== 'hidden' ||
    (isLocalChildWorkerSession(session) && isLocalTaskWorkerPurpose(session.purpose))
  );
}
