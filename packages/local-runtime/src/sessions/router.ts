import type {
  LocalRuntimeHost,
  LocalRuntimeTurnOutput,
  LocalToolContext,
} from "../runtime/host.js";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { deriveLocalRuntimeTurnOutcome } from "../runtime/host.js";
import type { ContextUsageToolCalibration } from "../context/context-usage-calibration.js";
import type {
  LocalSessionRecord,
  LocalSessionTurnInput,
  LocalSessionRuntime,
} from "./controller.js";

export type LocalRuntimeTelemetryPhase =
  | "start"
  | "success"
  | "failure"
  | "disabled";

export interface LocalRuntimeTelemetryEvent {
  runtime: LocalSessionRuntime;
  sessionId: string;
  turnId?: string;
  phase: LocalRuntimeTelemetryPhase;
  message?: string;
}

export type LocalRuntimeTelemetrySink = (
  event: LocalRuntimeTelemetryEvent,
) => void;

export type LocalSessionRoute =
  | { kind: "pi-agent"; session: LocalSessionRecord }
  | { kind: "legacy-opencode"; session: LocalSessionRecord; enabled: boolean };

export class LegacyOpencodeDisabledError extends Error {
  constructor(sessionId: string) {
    super(`Legacy opencode runtime is disabled for session ${sessionId}.`);
    this.name = "LegacyOpencodeDisabledError";
  }
}

export class LocalSessionRouter {
  private readonly runtimeHost: LocalRuntimeHost;
  private readonly legacyOpencodeEnabled: () => boolean;
  private readonly telemetry?: LocalRuntimeTelemetrySink;

  constructor(options: {
    runtimeHost: LocalRuntimeHost;
    legacyOpencodeEnabled?: () => boolean;
    telemetry?: LocalRuntimeTelemetrySink;
  }) {
    this.runtimeHost = options.runtimeHost;
    this.legacyOpencodeEnabled = options.legacyOpencodeEnabled ?? (() => true);
    this.telemetry = options.telemetry;
  }

  routeSession(session: LocalSessionRecord): LocalSessionRoute {
    if (session.runtime === "pi-agent") {
      return { kind: "pi-agent", session };
    }
    return {
      kind: "legacy-opencode",
      session,
      enabled: this.legacyOpencodeEnabled(),
    };
  }

  assertLegacyEnabled(sessionId: string): void {
    if (this.legacyOpencodeEnabled()) return;
    this.telemetry?.({
      runtime: "opencode",
      sessionId,
      phase: "disabled",
      message: "legacy_opencode_disabled",
    });
    throw new LegacyOpencodeDisabledError(sessionId);
  }

  getCachedContextUsageToolCalibration(input: {
    context: Context;
    model: Model<Api>;
  }): ContextUsageToolCalibration | undefined {
    return this.runtimeHost.contextUsageRuntime.getCachedToolCalibration(input);
  }

  async startTurn<TCtx extends LocalToolContext = LocalToolContext>(
    session: LocalSessionRecord,
    input: LocalSessionTurnInput<TCtx>,
  ): Promise<LocalRuntimeTurnOutput> {
    const route = this.routeSession(session);
    if (route.kind === "legacy-opencode") {
      this.assertLegacyEnabled(session.sessionId);
      throw new Error(
        `Legacy opencode session ${session.sessionId} must be streamed through LegacyHistoryReader.`,
      );
    }

    this.telemetry?.({
      runtime: "pi-agent",
      sessionId: session.sessionId,
      turnId: input.turnId,
      phase: "start",
    });
    try {
      const output = await this.runtimeHost.runTurn<TCtx>({
        ...input,
        sessionId: session.sessionId,
        workspaceDir: session.workspaceDir,
      });
      const outcome = deriveLocalRuntimeTurnOutcome(output.events);
      const turnFailed = outcome.status !== "completed";
      this.telemetry?.({
        runtime: "pi-agent",
        sessionId: session.sessionId,
        turnId: input.turnId,
        phase: turnFailed ? "failure" : "success",
        ...(turnFailed
          ? { message: outcome.errorMessage ?? `status_${outcome.status}` }
          : {}),
        ...(turnFailed && outcome.errorCode !== undefined
          ? { errorCode: outcome.errorCode }
          : {}),
      });
      return output;
    } catch (err) {
      this.telemetry?.({
        runtime: "pi-agent",
        sessionId: session.sessionId,
        turnId: input.turnId,
        phase: "failure",
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
}
