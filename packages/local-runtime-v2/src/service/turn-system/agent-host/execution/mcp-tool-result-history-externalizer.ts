import type { PiTurnRunnerLogger } from '@mavis/agent-core/pi-turn-runner';

import type {
  LocalToolResultHistoryFinalizer,
  LocalToolResultHistoryFinalizerInput,
} from './contracts.js';

const MCP_ARTIFACT_REFERENCE_KIND = 'mcp_tool_result_artifact';
const MCP_ARTIFACT_REFERENCE_VERSION = 1;

interface McpDetailArtifactInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly agentName: string;
  readonly workspaceDir: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: unknown;
  readonly text: string;
  readonly originalBytes: number;
  readonly sensitive: boolean;
}

interface McpDetailArtifact {
  readonly reference: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface McpToolResultHistoryExternalizerOptions {
  readonly maxInlineBytes: number;
  readonly getMaxInlineBytes?: () => number | undefined;
  readonly writeArtifact: (
    input: McpDetailArtifactInput,
  ) => McpDetailArtifact | Promise<McpDetailArtifact>;
  readonly logger?: PiTurnRunnerLogger;
}

/**
 * Keeps the raw MCP result available through Plugin PostToolUse, then replaces
 * oversized History details with a recoverable artifact reference.
 */
export class McpToolResultHistoryExternalizer {
  private readonly defaultMaxInlineBytes: number;

  constructor(private readonly options: McpToolResultHistoryExternalizerOptions) {
    this.defaultMaxInlineBytes = requirePositiveInteger(options.maxInlineBytes, 'maxInlineBytes');
  }

  readonly finalize: LocalToolResultHistoryFinalizer = async (input) => {
    const details = readRecord(input.toolContext.result.details);
    if (!details || !Object.prototype.hasOwnProperty.call(details, 'mcp')) return undefined;
    const mcp = details.mcp;
    if (isExternalizedMcpReference(mcp)) return undefined;

    let serialized: string;
    try {
      const value = JSON.stringify(mcp);
      if (value === undefined) return undefined;
      serialized = value;
    } catch (error) {
      this.log(input, {
        outcome: 'fallback',
        maxInlineBytes: this.readMaxInlineBytes(),
        reason: safeErrorReason(error),
      });
      return undefined;
    }

    const originalBytes = Buffer.byteLength(serialized);
    const maxInlineBytes = this.readMaxInlineBytes();
    if (originalBytes <= maxInlineBytes) return undefined;

    const artifactInput: McpDetailArtifactInput = {
      sessionId: input.sessionId,
      turnId: input.turnId,
      agentName: input.agentName,
      workspaceDir: input.workspaceDir,
      toolCallId: input.toolContext.toolCall.id,
      toolName: input.toolContext.toolCall.name,
      args: input.toolContext.args,
      text: serialized,
      originalBytes,
      sensitive: true,
    };

    try {
      const artifact = await this.options.writeArtifact(artifactInput);
      this.log(input, {
        outcome: 'externalized',
        originalBytes,
        maxInlineBytes,
        artifactReadFormat: readMetadataString(artifact.metadata, 'read_format'),
      });
      return {
        details: {
          ...details,
          mcp: buildMcpArtifactReference(artifact, originalBytes),
        },
      };
    } catch (error) {
      this.log(input, {
        outcome: 'fallback',
        originalBytes,
        maxInlineBytes,
        reason: safeErrorReason(error),
      });
      return undefined;
    }
  };

  private readMaxInlineBytes(): number {
    try {
      const live = this.options.getMaxInlineBytes?.();
      return isPositiveInteger(live) ? live : this.defaultMaxInlineBytes;
    } catch {
      return this.defaultMaxInlineBytes;
    }
  }

  private log(
    input: LocalToolResultHistoryFinalizerInput,
    decision: {
      readonly outcome: 'externalized' | 'fallback';
      readonly originalBytes?: number;
      readonly maxInlineBytes: number;
      readonly artifactReadFormat?: string;
      readonly reason?: string;
    },
  ): void {
    try {
      const fields = {
        event: 'mcp_tool_result_detail_budget_decision',
        session_id: input.sessionId,
        turn_id: input.turnId,
        tool_name: input.toolContext.toolCall.name,
        outcome: decision.outcome,
        ...(decision.originalBytes === undefined ? {} : { original_bytes: decision.originalBytes }),
        max_inline_bytes: decision.maxInlineBytes,
        ...(decision.artifactReadFormat
          ? { artifact_read_format: decision.artifactReadFormat }
          : {}),
        ...(decision.reason ? { reason: decision.reason } : {}),
      };
      this.options.logger?.[decision.outcome === 'fallback' ? 'error' : 'info']?.(
        fields,
        '[local-runtime-v2] MCP ToolResult detail budget',
      );
    } catch {
      // Diagnostics must never change the ToolResult selected for History.
    }
  }
}

function buildMcpArtifactReference(
  artifact: McpDetailArtifact,
  originalBytes: number,
): Readonly<Record<string, unknown>> {
  const readFormat = readMetadataString(artifact.metadata, 'read_format');
  const contentSha256 = readMetadataString(artifact.metadata, 'content_sha256');
  const rawReference = readMetadataString(artifact.metadata, 'raw_reference');
  return {
    kind: MCP_ARTIFACT_REFERENCE_KIND,
    version: MCP_ARTIFACT_REFERENCE_VERSION,
    externalized: true,
    reference: artifact.reference,
    original_bytes: originalBytes,
    content_type: 'application/json',
    ...(readFormat ? { read_format: readFormat } : {}),
    ...(contentSha256 ? { content_sha256: contentSha256 } : {}),
    ...(rawReference ? { raw_reference: rawReference } : {}),
  };
}

function isExternalizedMcpReference(value: unknown): boolean {
  const record = readRecord(value);
  return (
    record?.kind === MCP_ARTIFACT_REFERENCE_KIND &&
    record.version === MCP_ARTIFACT_REFERENCE_VERSION &&
    record.externalized === true &&
    typeof record.reference === 'string' &&
    record.reference.length > 0
  );
}

function readMetadataString(
  metadata: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function requirePositiveInteger(value: number, field: string): number {
  if (!isPositiveInteger(value)) {
    throw new TypeError(`McpToolResultHistoryExternalizer: ${field} must be a positive integer`);
  }
  return value;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function safeErrorReason(error: unknown): string {
  const record = readRecord(error);
  if (typeof record?.code === 'string') {
    const code = record.code.trim();
    if (code) return code;
  }
  return error instanceof Error && error.name.trim() ? error.name.trim() : 'unknown_error';
}
