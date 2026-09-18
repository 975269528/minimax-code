import type {
  CreateAgentInput as CreateAgentInput,
  CreateAgentResult as CreateAgentResult,
  DeleteAgentInput as DeleteAgentInput,
  DeleteAgentResult as DeleteAgentResult,
  GetAgentInput as GetAgentInput,
  GetAgentResult as GetAgentResult,
  ListAgentsInput as ListAgentsInput,
  ListAgentsResult as ListAgentsResult,
  UpdateAgentInput as UpdateAgentInput,
  UpdateAgentResult as UpdateAgentResult,
} from "@mavis/protocol/local";
import type { AgentReferenceResolver } from "@mavis/shared";
import type { LocalMavisAgentAdapter } from "@mavis/agent-tools/desktop";

export function isAgentNotFoundError(error: unknown): boolean {
  const candidate = Object(error) as { status?: unknown; code?: unknown };
  return candidate.status === 404 || candidate.code === "AGENT_NOT_FOUND";
}

/** A bounded Desktop-local image response; the port never exposes a file path. */
export interface LocalAgentAvatarAsset {
  readonly bytes: Uint8Array;
  readonly contentType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
}

export interface LocalAgentOwnerIdentity {
  readonly exactOwnerName: string;
  readonly ownerKind: "builtin" | "custom";
  readonly ownerInstanceId?: string;
}

export interface LocalSessionAgentRoutingSnapshot {
  readonly exactOwnerName: string;
  readonly ownerInstanceId?: string;
}

/** Canonical Project identity for a persisted Session, owned by Session V2. */
export interface LocalSessionProjectIdentity {
  readonly projectKey: string;
  readonly projectKind: "default" | "workspace";
  readonly workspaceDir?: string;
}

/**
 * Runtime-owned Agent capability consumed by the legacy HTTP/IM surfaces.
 *
 * The port deliberately lives in local-runtime and contains no V2 import. A
 * V2 composition can bind it before constructing the V1 host (for reference
 * resolution) and bind its management methods after Session/Application
 * readiness. An unbound port always fails closed; it never creates or reads a
 * legacy local-runtime Agent service/store as a fallback.
 */
export interface LocalAgentRuntimePort extends AgentReferenceResolver {
  listAgents(request: ListAgentsInput): Promise<ListAgentsResult>;
  createAgent(request: CreateAgentInput): Promise<CreateAgentResult>;
  getAgent(request: GetAgentInput): Promise<GetAgentResult>;
  updateAgent(request: UpdateAgentInput): Promise<UpdateAgentResult>;
  deleteAgent(request: DeleteAgentInput): Promise<DeleteAgentResult>;
  /** Safe canonical Custom-Agent avatar read for the Desktop HTTP host. */
  readCustomAgentAvatar(
    agentName: string,
  ): Promise<LocalAgentAvatarAsset | undefined>;
  setMainSession(agentName: string, sessionId: string): Promise<boolean>;
  agentExists(agentName: string): Promise<boolean>;
  /** Capability fact consumed by compatibility Team ingress. */
  canDelegate(agentName: string): Promise<boolean>;
  listLegacyPinnedAgentRefs(): Promise<
    Array<{ id: string; pinnedAt: number | null }>
  >;
  ensureBuiltinAgents(): Promise<void>;
  retryBuiltinGreetings(): Promise<void>;
  /** Canonical current owner incarnation used by Rootless route validation. */
  getAgentOwnerIdentity(requestRef: string): Promise<LocalAgentOwnerIdentity>;
  /** Frozen Session owner incarnation captured in the atomic Session create. */
  getSessionAgentRoutingSnapshot(
    sessionId: string,
  ): Promise<LocalSessionAgentRoutingSnapshot | undefined>;
  /** Read-only Session `project_id -> Project` identity; missing links fail closed. */
  getSessionProjectIdentity(
    sessionId: string,
  ): Promise<LocalSessionProjectIdentity | undefined>;
}

export interface LocalAgentRuntimeManagementPort {
  listAgents: LocalAgentRuntimePort["listAgents"];
  createAgent: LocalAgentRuntimePort["createAgent"];
  getAgent: LocalAgentRuntimePort["getAgent"];
  updateAgent: LocalAgentRuntimePort["updateAgent"];
  deleteAgent: LocalAgentRuntimePort["deleteAgent"];
  readCustomAgentAvatar: LocalAgentRuntimePort["readCustomAgentAvatar"];
  setMainSession: LocalAgentRuntimePort["setMainSession"];
  agentExists: LocalAgentRuntimePort["agentExists"];
  canDelegate: LocalAgentRuntimePort["canDelegate"];
  listLegacyPinnedAgentRefs: LocalAgentRuntimePort["listLegacyPinnedAgentRefs"];
  ensureBuiltinAgents: LocalAgentRuntimePort["ensureBuiltinAgents"];
  retryBuiltinGreetings: LocalAgentRuntimePort["retryBuiltinGreetings"];
  getAgentOwnerIdentity: LocalAgentRuntimePort["getAgentOwnerIdentity"];
  getSessionAgentRoutingSnapshot: LocalAgentRuntimePort["getSessionAgentRoutingSnapshot"];
  getSessionProjectIdentity: LocalAgentRuntimePort["getSessionProjectIdentity"];
}

export interface DeferredLocalAgentRuntimePort extends LocalAgentRuntimePort {
  bindResolver(resolver: AgentReferenceResolver): void;
  bindManagement(management: LocalAgentRuntimeManagementPort): void;
}

export class LocalAgentRuntimeUnavailableError extends Error {
  readonly status = 503;
  readonly code = "AGENT_RUNTIME_UNAVAILABLE";

  constructor(operation: string) {
    super(`Agent runtime capability is not bound: ${operation}`);
    this.name = "LocalAgentRuntimeUnavailableError";
  }
}

/** A direct-usage V1 host gets a deterministic 503 instead of a hidden writer. */
export function createFailClosedAgentRuntimePort(): LocalAgentRuntimePort {
  const unavailable = (operation: string): LocalAgentRuntimeUnavailableError =>
    new LocalAgentRuntimeUnavailableError(operation);
  return {
    resolveAgentReadScope: async () => {
      throw unavailable("resolveAgentReadScope");
    },
    resolveAgentWriteTarget: async () => {
      throw unavailable("resolveAgentWriteTarget");
    },
    requireExactAgentKey: async () => {
      throw unavailable("requireExactAgentKey");
    },
    resolveAgentExecutionTarget: async () => {
      throw unavailable("resolveAgentExecutionTarget");
    },
    listAgents: async () => {
      throw unavailable("listAgents");
    },
    createAgent: async () => {
      throw unavailable("createAgent");
    },
    getAgent: async () => {
      throw unavailable("getAgent");
    },
    updateAgent: async () => {
      throw unavailable("updateAgent");
    },
    deleteAgent: async () => {
      throw unavailable("deleteAgent");
    },
    readCustomAgentAvatar: async () => {
      throw unavailable("readCustomAgentAvatar");
    },
    setMainSession: async () => {
      throw unavailable("setMainSession");
    },
    agentExists: async () => {
      throw unavailable("agentExists");
    },
    canDelegate: async () => {
      throw unavailable("canDelegate");
    },
    listLegacyPinnedAgentRefs: async () => {
      throw unavailable("listLegacyPinnedAgentRefs");
    },
    ensureBuiltinAgents: async () => {
      throw unavailable("ensureBuiltinAgents");
    },
    retryBuiltinGreetings: async () => {
      throw unavailable("retryBuiltinGreetings");
    },
    getAgentOwnerIdentity: async () => {
      throw unavailable("getAgentOwnerIdentity");
    },
    getSessionAgentRoutingSnapshot: async () => {
      throw unavailable("getSessionAgentRoutingSnapshot");
    },
    getSessionProjectIdentity: async () => {
      throw unavailable("getSessionProjectIdentity");
    },
  };
}

/**
 * Deferred bridge used by V2 runtime while the V1 host is being constructed.
 * Resolver calls are available immediately; management calls become usable
 * only after the Session/Application owner has completed `ready()`.
 */
export function createDeferredLocalAgentRuntimePort(
  resolver?: AgentReferenceResolver,
): DeferredLocalAgentRuntimePort {
  const failClosed = createFailClosedAgentRuntimePort();
  let currentResolver = resolver;
  let currentManagement: LocalAgentRuntimeManagementPort | undefined;
  const management = (): LocalAgentRuntimeManagementPort =>
    currentManagement ?? failClosed;
  return {
    resolveAgentReadScope: (requestedName) =>
      (currentResolver ?? failClosed).resolveAgentReadScope(requestedName),
    resolveAgentWriteTarget: (requestedName) =>
      (currentResolver ?? failClosed).resolveAgentWriteTarget(requestedName),
    requireExactAgentKey: (requestedName) =>
      (currentResolver ?? failClosed).requireExactAgentKey(requestedName),
    resolveAgentExecutionTarget: (exactOwnerName) =>
      (currentResolver ?? failClosed).resolveAgentExecutionTarget(
        exactOwnerName,
      ),
    listAgents: (request) => management().listAgents(request),
    createAgent: (request) => management().createAgent(request),
    getAgent: (request) => management().getAgent(request),
    updateAgent: (request) => management().updateAgent(request),
    deleteAgent: (request) => management().deleteAgent(request),
    readCustomAgentAvatar: (agentName) =>
      management().readCustomAgentAvatar(agentName),
    setMainSession: (agentName, sessionId) =>
      management().setMainSession(agentName, sessionId),
    agentExists: (agentName) => management().agentExists(agentName),
    canDelegate: (agentName) => management().canDelegate(agentName),
    listLegacyPinnedAgentRefs: () => management().listLegacyPinnedAgentRefs(),
    ensureBuiltinAgents: () => management().ensureBuiltinAgents(),
    retryBuiltinGreetings: () => management().retryBuiltinGreetings(),
    getAgentOwnerIdentity: (requestRef) =>
      management().getAgentOwnerIdentity(requestRef),
    getSessionAgentRoutingSnapshot: (sessionId) =>
      management().getSessionAgentRoutingSnapshot(sessionId),
    getSessionProjectIdentity: (sessionId) =>
      management().getSessionProjectIdentity(sessionId),
    bindResolver: (next) => {
      currentResolver = next;
    },
    bindManagement: (next) => {
      currentManagement = next;
    },
  };
}

/** Adapt the neutral runtime port to the desktop tool's signal-tolerant shape. */
export function createLocalMavisAgentAdapter(
  port: LocalAgentRuntimePort,
): LocalMavisAgentAdapter {
  return {
    listAgents: (request) => port.listAgents(request),
    createAgent: (request) => port.createAgent(request),
    getAgent: (request) => port.getAgent(request),
    updateAgent: (request) => port.updateAgent(request),
    deleteAgent: (request) => port.deleteAgent(request),
    resolveAgentReadScope: async (requestedName) =>
      port.resolveAgentReadScope(requestedName),
    resolveAgentWriteTarget: (requestedName) =>
      port.resolveAgentWriteTarget(requestedName),
    requireExactAgentKey: (requestedName) =>
      port.requireExactAgentKey(requestedName),
  };
}
