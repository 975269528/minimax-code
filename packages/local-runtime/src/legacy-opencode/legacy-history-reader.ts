import type { AgentMessage } from "@mavis/agent-core/protocol/agent-message";
import type { LocalSessionRecord } from "../sessions/controller.js";
import { LegacyOpencodeStore } from "./legacy-opencode-store.js";
export interface LegacyHistoryReaderOptions {
  dataDir: string;
  available?: boolean;
  store?: LegacyOpencodeStore;
}
/** Read-only legacy session files; does not start processes, proxy requests, or execute legacy sessions. */
export class LegacyHistoryReader {
  private readonly store: LegacyOpencodeStore;
  constructor(private readonly options: LegacyHistoryReaderOptions) {
    this.store =
      options.store ?? new LegacyOpencodeStore({ dataDir: options.dataDir });
  }
  async getSession(id: string): Promise<LocalSessionRecord | undefined> {
    return this.options.available === false
      ? undefined
      : this.store.getSession(id);
  }
  async listSessions(agentName?: string): Promise<LocalSessionRecord[]> {
    return this.options.available === false
      ? []
      : this.store.listSessions(agentName);
  }
  async listMessages(id: string, limit?: number): Promise<AgentMessage[]> {
    return this.options.available === false
      ? []
      : this.store.listMessages(id, limit);
  }
}
