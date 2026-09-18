import {
  LocalAgentService,
  type LocalAgentServiceOptions,
} from '../../src/service/agent/application/agent.service.js';

/**
 * Builds a `LocalAgentService` for tests that are not about model validation.
 *
 * Every Agent write path is fail-closed on the candidate-model gate (see
 * `AgentConfigDocuments.assertCandidateModelIsUsable`): an unbound validator
 * means "the runtime is not ready", not "allowed". Production binds the real
 * validator in `runtime-session-composition`; storage/service tests that only
 * exercise persistence bind a permissive one here so the gate does not mask
 * what they actually assert.
 *
 * Tests covering the gate itself bind their own validator instead of using
 * this helper.
 */
export function createTestAgentService(options: LocalAgentServiceOptions): LocalAgentService {
  const service = new LocalAgentService(options);
  service.bindCandidateModelValidator(async () => ({ ok: true }));
  return service;
}
