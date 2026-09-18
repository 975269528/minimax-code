import type { CronService } from "../../service/cron/index.js";

class CronUnavailableError extends Error {
  readonly code = "CRON_UNAVAILABLE";

  constructor() {
    super("Cron is not available on this runtime host");
    this.name = "CronUnavailableError";
  }
}

export interface V1CronAgentCleanupBridge {
  deleteAgentCronTasks(agentName: string): Promise<void>;
  bind(service: Pick<CronService, "deleteDefinitionsByAgent">): void;
}

/** Stable Agent-cleanup callback passed to v1 before Cron v2 is ready. */
export function createV1CronAgentCleanupBridge(): V1CronAgentCleanupBridge {
  let service: Pick<CronService, "deleteDefinitionsByAgent"> | undefined;
  return {
    async deleteAgentCronTasks(agentName) {
      if (!service) throw new CronUnavailableError();
      service.deleteDefinitionsByAgent(agentName);
    },
    bind(next) {
      if (service) throw new Error("Cron Agent cleanup is already bound");
      service = next;
    },
  };
}
