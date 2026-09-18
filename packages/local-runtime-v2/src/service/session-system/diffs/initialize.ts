import type { SessionDiffReader } from './contracts.js';
import { SessionDiffService } from './service.js';

export function initializeSessionDiffCapability(sessions: SessionDiffReader): SessionDiffService {
  return new SessionDiffService(sessions);
}
