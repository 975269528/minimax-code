/**
 * `@mavis/agent-core/tools` —— tool protocol types, `defineRuntimeTool`, and
 * decorated-class `bindTool` / `toRuntimeTool` helpers.
 *
 * Usage:
 *
 * ```ts
 * import { defineRuntimeTool } from '@mavis/agent-core/tools';
 * import { Type } from '@sinclair/typebox';
 *
 * const CloudBashTool = defineRuntimeTool({
 *   name: 'bash',
 *   description: 'Execute a command in the cloud sandbox executor.',
 *   schema: Type.Object({ command: Type.String() }),
 *   async execute(ctx, input, signal) { ... },
 * });
 * ```
 */

export type {
  ToolDefinition,
  ToolImpl,
  ToolResult,
  ToolResultContent,
  ToolExecutionContext,
  ToolExecutionMode,
  ToolOperationClassifier,
  RuntimeTool,
  RuntimeToolSource,
  ToolCallProvenanceResolutionInput,
  ToolCallProvenanceResolver,
} from './types.js';
export { defineRuntimeTool, type RuntimeToolDeclaration } from './define.js';
export { bindTool, toRuntimeTool } from './bind.js';
export { prepareEditArguments, type PreparedEditArguments } from './edit-prepare-arguments.js';
export { isRuntimeToolInputValid } from './input-validation.js';
export {
  ReadToolDef,
  WriteToolDef,
  EditToolDef,
  BashToolDef,
  GrepToolDef,
  GlobToolDef,
  TodoWriteToolDef,
  TaskToolDef,
  type ReadToolInput,
  type WriteToolInput,
  type EditToolInput,
  type BashToolInput,
  type GrepToolInput,
  type GlobToolInput,
  type TodoWriteToolInput,
  type TaskToolInput,
} from './builtin-defs.js';
