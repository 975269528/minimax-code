import type { GlobalEventInput } from "@mavis/shared/global-events";

import type {
  V1ServiceCompatibility,
  V1ServiceFactory,
} from "../../compat/v1/runtime.js";
import type { LocalAgentService } from "../../service/agent/index.js";
import type { PluginServiceLogger } from "../../service/plugin-system/index.js";
import {
  initializeWorkspaceSystem,
  type WorkspaceSystem,
} from "../../service/workspace/index.js";
import type { ProductionSessionComposition } from "./runtime-session-composition.js";

export function resolveServicesCompatibility(
  compatibility: V1ServiceCompatibility | V1ServiceFactory,
): V1ServiceCompatibility {
  return "create" in compatibility ? compatibility.create() : compatibility;
}

export function createRuntimeAgentReferenceProjection(
  compatibility: V1ServiceCompatibility,
  agentService: LocalAgentService,
  logger: PluginServiceLogger,
): NonNullable<
  ProductionSessionComposition["product"]["inputPreparation"]["agentReferenceProjection"]
> {
  return {
    resolveAgentReference: async (requestRef) => {
      const resolution =
        await compatibility.agentReferences.resolveDelegatable(requestRef);
      if (resolution !== "authorized") return resolution;
      try {
        const trustedDisplayName = (
          await agentService.get(requestRef)
        ).displayName.trim();
        return trustedDisplayName
          ? { status: "authorized" as const, trustedDisplayName }
          : { status: "authorized" as const };
      } catch {
        return { status: "authorized" as const };
      }
    },
    emitDiagnostic: (event) =>
      logger.info(
        {
          stage: event.stage,
          outcome: event.outcome,
          count: event.count,
          surface: event.surface,
          runtime: event.runtime,
          ...(event.errorCode ? { errorCode: event.errorCode } : {}),
        },
        "agent_reference",
      ),
  };
}

export function createServiceWorkspace(
  writeGlobalEvent: (event: GlobalEventInput) => void,
): WorkspaceSystem {
  return initializeWorkspaceSystem({
    git: {
      publishChanged: (payload) =>
        writeGlobalEvent({ type: "workspace.git.changed", payload }),
    },
  });
}
