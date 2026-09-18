import type { LocalAgentRuntimeManagementPort } from "@mavis/local-runtime";
import type {
  CreateAgentInput as CreateAgentReq,
  CreateAgentResult as CreateAgentResp,
  DeleteAgentInput as DeleteAgentReq,
  DeleteAgentResult as DeleteAgentResp,
  GetAgentInput as GetAgentReq,
  GetAgentResult as GetAgentResp,
  ListAgentsInput as ListAgentsReq,
  ListAgentsResult as ListAgentsResp,
  UpdateAgentInput as UpdateAgentReq,
  UpdateAgentResult as UpdateAgentResp,
} from "@mavis/protocol/local";

import type { AgentApplication } from "../application/agent/agent-application.js";
import { createAgentManagementApplication } from "../application/agent/management-application.js";
import type { ApplicationContext } from "../application/context.js";
import type { LocalAgentService } from "../service/agent/index.js";
import {
  type CanonicalSessionProjectIdentity,
  type SessionAgentDefinition,
  type SessionRecord,
} from "../service/session-system/index.js";

/**
 * V1 transport/desktop consumers use this bridge while V2 remains the only
 * Agent owner. The HTTP controller remains the single wire-mapping boundary;
 * builtin content is supplied by the V2 application read model.
 */
export function createV2AgentRuntimeManagementPort(input: {
  readonly application: AgentApplication;
  readonly service: LocalAgentService;
  readonly readSessionAgentRouting: (sessionId: string) => Promise<
    | {
        readonly session: Pick<SessionRecord, "agentName">;
        readonly definition?: SessionAgentDefinition;
      }
    | undefined
  >;
  readonly resolveSessionProjectIdentity: (
    sessionId: string,
  ) => Promise<CanonicalSessionProjectIdentity | undefined>;
}): LocalAgentRuntimeManagementPort {
  const controller = createAgentManagementApplication(input.application);
  const context: ApplicationContext = {};
  return {
    listAgents: (request: ListAgentsReq): Promise<ListAgentsResp> =>
      controller.listAgents(context, request),
    createAgent: (request: CreateAgentReq): Promise<CreateAgentResp> =>
      controller.createAgent(context, request),
    getAgent: (request: GetAgentReq): Promise<GetAgentResp> =>
      controller.getAgent(context, request),
    updateAgent: (request: UpdateAgentReq): Promise<UpdateAgentResp> =>
      controller.updateAgent(context, request),
    deleteAgent: (request: DeleteAgentReq): Promise<DeleteAgentResp> =>
      controller.deleteAgent(context, request),
    readCustomAgentAvatar: (agentName) =>
      input.service.readCustomAvatar(agentName),
    setMainSession: (agentName, sessionId) =>
      input.application.setRootSession(agentName, sessionId),
    // This is a storage predicate, not a canonical view lookup: old installs
    // may render Mavis while persisting only Main.
    agentExists: async (agentName) =>
      Boolean(await input.service.getPersistedOwner(agentName)),
    canDelegate: async (agentName) => {
      const scope = await input.service.resolveAgentReadScope(agentName);
      const profile = await input.service.renderProfile({
        exactOwnerName: scope.exactOwnerName,
        requestRef: agentName,
        surface: "interactive",
        appMode: "coding",
        promptChannel: "online",
      });
      const tools = profile.capabilityCeiling.tools;
      return (
        profile.capabilityCeiling.features.mavis &&
        profile.capabilityCeiling.features.delegation &&
        (tools === undefined || tools.includes("bash"))
      );
    },
    listLegacyPinnedAgentRefs: async () => [
      ...(await input.application.listLegacyPinnedAgentRefs()),
    ],
    ensureBuiltinAgents: async () => {
      await input.application.ensureBuiltinDefinitionsForPhase2();
    },
    retryBuiltinGreetings: async () => undefined,
    getAgentOwnerIdentity: async (requestRef) => {
      const document = await input.application.getConfigDocument(requestRef);
      return {
        exactOwnerName: document.exactOwnerName,
        ownerKind: document.ownerKind,
        ...(document.ownerInstanceId
          ? { ownerInstanceId: document.ownerInstanceId }
          : {}),
      };
    },
    getSessionAgentRoutingSnapshot: async (sessionId) => {
      const routing = await input.readSessionAgentRouting(sessionId);
      if (!routing) return undefined;
      const definition = routing.definition?.definition;
      if (definition?.definitionVersion === 2) {
        return {
          exactOwnerName: definition.exactOwnerName,
          ...(definition.ownerInstanceId
            ? { ownerInstanceId: definition.ownerInstanceId }
            : {}),
        };
      }
      const owner = await input.application.getConfigDocument(
        `agent:${routing.session.agentName}`,
      );
      return {
        exactOwnerName: owner.exactOwnerName,
        ...(owner.ownerInstanceId
          ? { ownerInstanceId: owner.ownerInstanceId }
          : {}),
      };
    },
    getSessionProjectIdentity: (sessionId) =>
      input.resolveSessionProjectIdentity(sessionId),
  };
}
