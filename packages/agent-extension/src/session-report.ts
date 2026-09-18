import type { AgentExtension, LlmCallPreparedHandler } from '@mavis/agent-runtime';
import type { SessionLlmCallReportCapability } from '@mavis/session-report';

export interface SessionReportExtensionOptions {
  readonly reports: Pick<SessionLlmCallReportCapability, 'writeCurrent'>;
  readonly reportFailure?: (sessionId: string, message: string) => void;
}

/**
 * Agent-call adapter only. The host owns the report store and binds committed
 * compaction/rewind/fork notifications independently of the turn lifecycle.
 */
export function sessionReportExtension(options: SessionReportExtensionOptions): AgentExtension {
  const capture: LlmCallPreparedHandler = async (input, context) => {
    try {
      await options.reports.writeCurrent({
        sessionId: input.sessionId,
        turnId: input.turnId,
        envelope: {
          schemaVersion: 1,
          systemPrompt: input.systemPrompt,
          tools: input.tools.map(({ name, description, parameters }) => ({
            name,
            description,
            parameters,
          })),
          model: String(input.model.id),
          provider: String(input.model.provider),
          api: String(input.model.api),
          thinkingLevel: String(input.thinkingLevel),
          ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
          ...(input.hostMaxOutputTokens === undefined
            ? {}
            : { hostMaxOutputTokens: input.hostMaxOutputTokens }),
          ...(input.maxSerializedInputBytes === undefined
            ? {}
            : { maxSerializedInputBytes: input.maxSerializedInputBytes }),
          ...(input.cacheRetention === undefined
            ? {}
            : { cacheRetention: String(input.cacheRetention) }),
          ...(context.outputContract?.schema === undefined
            ? {}
            : { outputSchema: context.outputContract.schema }),
          ...(context.outputContract?.revisionInstruction === undefined
            ? {}
            : { outputRevisionInstruction: context.outputContract.revisionInstruction }),
        },
      });
    } catch (error) {
      try {
        options.reportFailure?.(
          input.sessionId,
          `session_llm_call_evidence_failed:${error instanceof Error ? error.message : String(error)}`,
        );
      } catch {
        // Neither evidence IO nor its diagnostics may interrupt a provider call.
      }
    }
  };
  return {
    id: 'session-report',
    description: 'Capture the non-message environment of prepared agent LLM calls.',
    init(api) {
      api.on('on_llm_call_prepared', capture);
    },
  };
}
