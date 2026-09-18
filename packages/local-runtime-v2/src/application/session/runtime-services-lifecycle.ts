import type { InitializedCronService } from "../../service/cron/index.js";
import type { InitializedMcpService } from "../../service/mcp/index.js";
import type { RuntimeMiniAppServices } from "../../service/miniapp/index.js";
import type { PlanService } from "../../service/plan/index.js";
import {
  settleInBackground,
  type InitializedPluginService,
} from "../../service/plugin-system/index.js";
import type { SessionSystemOwner } from "../../service/session-system/index.js";
import {
  abortLocalPluginHookSessionTurn,
  endLocalPluginHookSession,
  type TurnSystemOwner,
} from "../../service/turn-system/index.js";
import type {
  WorkspaceGitService,
  WorkspaceHtmlPreviewService,
} from "../../service/workspace/index.js";
import type { LocalSandboxService } from "../../service/sandbox/index.js";
import type { AgentApplication } from "../agent/agent-application.js";
import type { RuntimeApplications } from "../initialize.js";
import { describeError } from "./turn-message-delivery.js";

export interface RuntimeServicesLifecycleState {
  closed: boolean;
}

export async function closeRuntimeServiceOwnersAfterFailure(input: {
  readonly cron: InitializedCronService | undefined;
  readonly turnSystem: TurnSystemOwner | undefined;
  readonly plugin: InitializedPluginService | undefined;
  readonly mcp: InitializedMcpService | undefined;
  readonly sessionSystem: SessionSystemOwner;
  readonly miniApp: RuntimeMiniAppServices["miniApp"];
}): Promise<void> {
  for (const close of [
    () => input.cron?.close(),
    () => input.turnSystem?.close(),
    () => input.plugin?.close(),
    () => input.mcp?.close(),
    () => input.sessionSystem.close(),
    () => input.miniApp?.close(),
  ]) {
    try {
      await close();
    } catch {
      // The original startup failure remains authoritative after best-effort reverse drain.
    }
  }
}

export interface RuntimePluginAuthContextNotifierInput {
  readonly authContextChanged: () => void;
  readonly enabledHookPluginNames: () => ReadonlySet<string>;
  readonly abortSession: (sessionId: string) => Promise<unknown>;
  readonly endAllSessionsForLogout: (
    enabledPluginNames: ReadonlySet<string>,
    abortSession: (sessionId: string) => Promise<unknown>,
  ) => Promise<void>;
}

export function createRuntimePluginSessionLifecycle(
  turnSystem: TurnSystemOwner,
  plugin: InitializedPluginService,
): {
  readonly runPluginHookSessionEndFence: TurnSystemOwner["sessionLifecycle"]["runExclusive"];
  readonly preparePluginHookSessionEnd: (sessionId: string) => Promise<void>;
  readonly endPluginHookSession: (sessionId: string) => Promise<void>;
} {
  return {
    runPluginHookSessionEndFence: turnSystem.sessionLifecycle.runExclusive,
    preparePluginHookSessionEnd: (sessionId) =>
      abortLocalPluginHookSessionTurn(sessionId, (executionSessionId) =>
        turnSystem.turns.abort({
          sessionId: executionSessionId,
          reason: "session-archive",
        }),
      ),
    endPluginHookSession: (sessionId) =>
      endLocalPluginHookSession(
        sessionId,
        "archive",
        plugin.enabledHookPluginNames(),
      ),
  };
}

export function createRuntimePluginAuthContextNotifier(
  input: RuntimePluginAuthContextNotifierInput,
): (authState?: "pending" | "authenticated" | "logged_out") => Promise<void> {
  return async (authState) => {
    const enabledBeforeChange = input.enabledHookPluginNames();
    input.authContextChanged();
    if (authState !== "logged_out") return;
    await input.endAllSessionsForLogout(
      enabledBeforeChange,
      input.abortSession,
    );
  };
}

export interface RuntimeServicesLifecycleInput {
  readonly recoverPersistedState?: boolean;
  readonly state: RuntimeServicesLifecycleState;
  readonly bindGlobalEventPublisher: () => () => void;
  readonly reportFailure?: (scope: string, message: string) => void;
  readonly bindConversation: () => Promise<void>;
  readonly recoverQuestionnaires: () => Promise<void>;
  readonly shutdownConversation: () => void;
  readonly sessionSystem: SessionSystemOwner;
  readonly workspaceGit: WorkspaceGitService;
  readonly workspaceHtmlPreview: WorkspaceHtmlPreviewService;
  readonly plan: PlanService;
  readonly turnSystem: TurnSystemOwner;
  readonly cron: InitializedCronService | undefined;
  readonly plugin: InitializedPluginService;
  readonly mcp: InitializedMcpService;
  readonly agentApplication: AgentApplication;
  readonly applications: RuntimeApplications;
  readonly sandbox: Pick<LocalSandboxService, "initialize" | "close">;
  readonly disposePluginHookSessions?: () => void | Promise<void>;
  /** Releases the V2 Browser owner after active turns have drained. */
  readonly closeBrowserUse?: () => void | Promise<void>;
}

/**
 * A Sandbox that cannot initialize must not take the control plane down with
 * it: the service stays `failed` and Bash keeps failing closed, but the HTTP
 * surface has to stay up so the user can still disable or retry it.
 */
async function initializeSandboxWithoutBlockingStartup(
  input: Pick<RuntimeServicesLifecycleInput, "sandbox" | "reportFailure">,
): Promise<void> {
  try {
    await input.sandbox.initialize();
  } catch (error) {
    input.reportFailure?.(
      "sandbox-initialization",
      `owner=sandbox;component=local-sandbox;stage=startup-initialize;error=${describeError(error)}`,
    );
  }
}

/** Owns the dependency-ordered ready and close sequence of the composed services. */
export function createRuntimeServicesLifecycle(
  input: RuntimeServicesLifecycleInput,
): {
  readonly builtinAgentDefinitionsReady: Promise<boolean>;
  readonly ready: () => Promise<void>;
  readonly close: () => Promise<void>;
} {
  let unbindGlobalEventPublisher: (() => void) | undefined;
  let readyPromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;
  let backgroundAgentRecovery: BackgroundAgentRecovery | undefined;
  let resolveBuiltinAgentDefinitionsReady!: (ready: boolean) => void;
  const builtinAgentDefinitionsReady = new Promise<boolean>((resolve) => {
    resolveBuiltinAgentDefinitionsReady = resolve;
  });

  const readyServices = async (): Promise<void> => {
    if (input.state.closed) {
      resolveBuiltinAgentDefinitionsReady(false);
      return;
    }
    const startup = await prepareRuntimeStartupBeforeCron(
      input,
      input.recoverPersistedState !== false,
      () => {
        unbindGlobalEventPublisher = input.bindGlobalEventPublisher();
      },
    );
    if (!startup.completed) return;
    await input.cron?.ready();
    if (startup.retryPlanLifecycleRecovery && !input.state.closed) {
      input.plan.lifecycleReconciler.schedule("startup-recovery");
    }
    if (input.state.closed) return;
    backgroundAgentRecovery = startBackgroundAgentRecovery(
      input,
      resolveBuiltinAgentDefinitionsReady,
    );
  };
  const unbindV1GlobalEventPublisher = (): Promise<void> => {
    const unbind = unbindGlobalEventPublisher;
    unbindGlobalEventPublisher = undefined;
    unbind?.();
    return Promise.resolve();
  };
  const closeServices = async (): Promise<void> => {
    input.state.closed = true;
    resolveBuiltinAgentDefinitionsReady(false);
    try {
      await readyPromise;
    } catch {
      // Startup failure is handled by its owner; closing must still drain acquired services.
    }
    backgroundAgentRecovery?.controller.abort();
    await backgroundAgentRecovery?.settled;
    const failures: unknown[] = [];
    const closeSteps = [
      () => Promise.resolve(input.workspaceHtmlPreview.close()),
      () => Promise.resolve(input.plan.lifecycleReconciler.close()),
      () => Promise.resolve(input.shutdownConversation()),
      unbindV1GlobalEventPublisher,
      () => Promise.resolve(input.cron?.close()),
      () => Promise.resolve(input.turnSystem.close()),
      () => Promise.resolve(input.closeBrowserUse?.()),
      () => Promise.resolve(input.disposePluginHookSessions?.()),
      () => Promise.resolve(input.plugin.close()),
      () => Promise.resolve(input.mcp.close()),
      () => Promise.resolve(input.agentApplication.close()),
      () => Promise.resolve(input.workspaceGit.close()),
      () => Promise.resolve(input.sessionSystem.close()),
      () => Promise.resolve(input.sandbox.close()),
    ];
    for (const close of closeSteps) {
      try {
        await close();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw failures[0];
  };

  return {
    builtinAgentDefinitionsReady,
    ready: () => {
      readyPromise ??= readyServices();
      return readyPromise;
    },
    close: () => {
      closePromise ??= closeServices();
      return closePromise;
    },
  };
}

interface RuntimeStartupBeforeCron {
  readonly completed: boolean;
  readonly retryPlanLifecycleRecovery: boolean;
}

async function prepareRuntimeStartupBeforeCron(
  input: RuntimeServicesLifecycleInput,
  recoverPersistedState: boolean,
  bindGlobalEventPublisher: () => void,
): Promise<RuntimeStartupBeforeCron> {
  for (const step of createRuntimeStartupSteps(
    input,
    recoverPersistedState,
    bindGlobalEventPublisher,
  )) {
    if (input.state.closed)
      return { completed: false, retryPlanLifecycleRecovery: false };
    await step();
  }
  if (input.state.closed)
    return { completed: false, retryPlanLifecycleRecovery: false };
  const retryPlanLifecycleRecovery = recoverPersistedState
    ? await recoverPlanLifecycleOnStartup(input)
    : false;
  return { completed: !input.state.closed, retryPlanLifecycleRecovery };
}

function createRuntimeStartupSteps(
  input: RuntimeServicesLifecycleInput,
  recoverPersistedState: boolean,
  bindGlobalEventPublisher: () => void,
): ReadonlyArray<() => void | Promise<void>> {
  return [
    bindGlobalEventPublisher,
    () => input.sessionSystem.ready(),
    ...(recoverPersistedState
      ? [() => reconcilePreparedPlanDocuments(input)]
      : []),
    () => input.mcp.ready(),
    () => input.plugin.ready(),
    () => recoverPendingForksFailSoft(input),
    () => initializeSandboxWithoutBlockingStartup(input),
    () => input.turnSystem.ready(),
    () => input.bindConversation(),
    ...(recoverPersistedState
      ? [() => recoverQuestionnairesOnStartup(input)]
      : []),
  ];
}

async function reconcilePreparedPlanDocuments(
  input: Pick<RuntimeServicesLifecycleInput, "sessionSystem" | "reportFailure">,
): Promise<void> {
  try {
    await input.sessionSystem.planDocuments.reconcilePreparedDrafts();
  } catch (error) {
    input.reportFailure?.(
      "plan-document-recovery",
      `owner=session-system;component=plan-document;stage=startup-reconcile;error=${describeError(error)}`,
    );
  }
}

async function recoverQuestionnairesOnStartup(
  input: Pick<
    RuntimeServicesLifecycleInput,
    "recoverQuestionnaires" | "reportFailure"
  >,
): Promise<void> {
  try {
    await input.recoverQuestionnaires();
  } catch (error) {
    input.reportFailure?.(
      "questionnaire-recovery",
      `owner=questionnaire;stage=startup-recovery;error=${describeError(error)}`,
    );
  }
}

async function recoverPlanLifecycleOnStartup(
  input: Pick<RuntimeServicesLifecycleInput, "plan">,
): Promise<boolean> {
  try {
    await input.plan.lifecycleReconciler.recoverStartup();
    return false;
  } catch {
    return true;
  }
}

interface BackgroundAgentRecovery {
  readonly controller: AbortController;
  /** Settles after every started Agent filesystem mutation has stopped. */
  readonly settled: Promise<void>;
}

/**
 * Builtin definitions and legacy Custom Agent rows are repaired after core
 * readiness. Shutdown aborts later stages and drains an active mutation before
 * closing the Agent and database owners.
 */
function startBackgroundAgentRecovery(
  input: Pick<
    RuntimeServicesLifecycleInput,
    "state" | "agentApplication" | "reportFailure"
  >,
  resolveBuiltinAgentDefinitionsReady: (ready: boolean) => void,
): BackgroundAgentRecovery | undefined {
  if (input.state.closed) {
    resolveBuiltinAgentDefinitionsReady(false);
    return undefined;
  }
  const controller = new AbortController();
  let resolveSettled!: () => void;
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  setImmediate(() => {
    settleInBackground(
      (async () => {
        try {
          await runBackgroundAgentRecoverySafely(
            input,
            controller.signal,
            resolveBuiltinAgentDefinitionsReady,
          );
        } finally {
          resolveSettled();
        }
      })(),
    );
  });
  return { controller, settled };
}

async function runBackgroundAgentRecoverySafely(
  input: Pick<
    RuntimeServicesLifecycleInput,
    "state" | "agentApplication" | "reportFailure"
  >,
  signal: AbortSignal,
  resolveBuiltinAgentDefinitionsReady: (ready: boolean) => void,
): Promise<void> {
  if (input.state.closed || signal.aborted) {
    resolveBuiltinAgentDefinitionsReady(false);
    return;
  }
  try {
    await runBackgroundAgentRecovery(
      input,
      signal,
      resolveBuiltinAgentDefinitionsReady,
    );
  } catch (error) {
    if (signal.aborted) return;
    reportStartupFailure(
      input,
      "agent-startup-recovery",
      `owner=agent;stage=background-runner;error=${describeError(error)}`,
    );
  } finally {
    resolveBuiltinAgentDefinitionsReady(false);
  }
}

async function runBackgroundAgentRecovery(
  input: Pick<
    RuntimeServicesLifecycleInput,
    "agentApplication" | "reportFailure"
  >,
  signal: AbortSignal,
  resolveBuiltinAgentDefinitionsReady: (ready: boolean) => void,
): Promise<void> {
  let stage = "builtin-definitions";
  let builtinDefinitionsReady = false;
  try {
    await input.agentApplication.ensureBuiltinDefinitionsForPhase2();
    if (signal.aborted) return;
    builtinDefinitionsReady = true;
    stage = "legacy-custom-materialization";
    await input.agentApplication.materializeLegacyCustomAgents();
  } catch (error) {
    if (signal.aborted) return;
    reportStartupFailure(
      input,
      "agent-startup-recovery",
      `owner=agent;stage=${stage};error=${describeError(error)}`,
    );
  } finally {
    resolveBuiltinAgentDefinitionsReady(
      builtinDefinitionsReady && !signal.aborted,
    );
  }
}

function reportStartupFailure(
  input: Pick<RuntimeServicesLifecycleInput, "reportFailure">,
  scope: string,
  message: string,
): void {
  try {
    input.reportFailure?.(scope, message);
  } catch {
    // Diagnostics are side effects and cannot become a core readiness gate.
  }
}

async function recoverPendingForksFailSoft(
  input: Pick<RuntimeServicesLifecycleInput, "applications" | "reportFailure">,
): Promise<void> {
  try {
    await input.applications.session.conversationMutation?.recoverPendingForks();
  } catch (error) {
    reportStartupFailure(
      input,
      "pending-fork-recovery",
      `owner=session;stage=pending-fork-recovery;error=${describeError(error)}`,
    );
  }
}
