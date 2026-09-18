import type { ToolExecutionContext } from "@mavis/agent-core/tools";

/** Local diagnostic port for tool execution, independent of tool vendors or upload protocols. */
export interface ToolDiagnosticLogger {
  info(
    context: ToolExecutionContext & { readonly workspaceRoot?: string },
    message: string,
  ): void;
  warn(
    context: ToolExecutionContext & { readonly workspaceRoot?: string },
    message: string,
  ): void;
  debug?(
    context: ToolExecutionContext & { readonly workspaceRoot?: string },
    message: string,
  ): void;
}
