import type { LocalSessionRecord } from '../sessions/controller.js';
import { isLocalChildWorkerSession } from '../sessions/session-policy.js';

export function shouldEnableLocalTaskTool(session: LocalSessionRecord): boolean {
  return !isLocalChildWorkerSession(session);
}
