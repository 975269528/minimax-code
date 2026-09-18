import { isCompatibleChannelAgentOwner } from './agent-owner-compatibility.js';
import type { LocalChannelBridgeInfraOptions } from './infra.js';
import { LocalChannelRootlessError } from './rootless-route-resolver.js';

/** Validates the immutable Agent and Project boundary before an IM cursor CAS. */
export async function validateImBindingTargetSession(
  options: Pick<
    LocalChannelBridgeInfraOptions,
    'getSessionById' | 'resolveAgentReadScope' | 'rootlessV2'
  >,
  input: { sessionId: string; agentName: string; projectKey: string },
): Promise<void> {
  const rootless = options.rootlessV2;
  if (!rootless) {
    throw new LocalChannelRootlessError(
      503,
      'ROOTLESS_CHANNEL_UNAVAILABLE',
      'Rootless Channel routing is unavailable.',
    );
  }
  const [session, owner, project] = await Promise.all([
    options.getSessionById(input.sessionId),
    rootless.getAgentOwnerIdentity(input.agentName),
    rootless.getSessionProjectIdentity(input.sessionId),
  ]);
  const targetInvalid = () =>
    new LocalChannelRootlessError(
      409,
      'CHANNEL_IM_TARGET_SESSION_INVALID',
      'The IM Binding target Session does not match the Agent and Project.',
    );
  if (
    !session ||
    session.archived ||
    session.runtime !== 'pi-agent' ||
    (session.parentSessionId !== null && session.parentSessionId !== undefined) ||
    !isImTargetSession(session) ||
    !project ||
    project.projectKey !== input.projectKey
  ) {
    throw targetInvalid();
  }
  if (
    !(await isCompatibleChannelAgentOwner({
      persisted: { exactOwnerName: session.agentName },
      current: owner,
      ...(options.resolveAgentReadScope
        ? { resolveAgentReadScope: options.resolveAgentReadScope }
        : {}),
    }))
  ) {
    throw targetInvalid();
  }
  const snapshot = await rootless.getSessionAgentRoutingSnapshot(session.sessionId);
  if (
    !snapshot ||
    !(await isCompatibleChannelAgentOwner({
      persisted: snapshot,
      current: owner,
      ...(options.resolveAgentReadScope
        ? { resolveAgentReadScope: options.resolveAgentReadScope }
        : {}),
    }))
  ) {
    throw targetInvalid();
  }
}

function isImTargetSession(session: {
  readonly sessionType?: string;
  readonly sessionKind?: string;
}): boolean {
  return (
    (session.sessionType === 'branch' &&
      (session.sessionKind === 'channel' || session.sessionKind === 'conversation')) ||
    (session.sessionType === 'root' && session.sessionKind === 'conversation')
  );
}
