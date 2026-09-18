import type { RuntimeTool } from '@mavis/agent-core/tools';

export interface DesktopTurnSkillCapability {
  readonly pluginName: string;
  readonly name: string;
  readonly description: string;
  readonly content: string;
  readonly location: string;
  readonly sourceKind: string;
}

export interface DesktopTurnPluginCapability {
  readonly name: string;
  readonly displayName?: string;
  readonly iconPath?: string;
  readonly appProviders: readonly string[];
}

export type DesktopTurnToolMode = 'omit' | 'inline' | 'tool_search';

export interface DesktopTurnRuntimeToolBinding {
  readonly kind: 'app' | 'mcp';
  readonly source: string;
  readonly pluginName?: string;
  /** Connector/App tool loading mode; absent values still use inline. */
  readonly toolMode?: DesktopTurnToolMode;
  readonly tool: RuntimeTool;
}

/** Read-only v2 capability projection consumed by retained v1 product adapters. */
export interface DesktopTurnCapabilityView {
  readonly revision: string;
  readonly plugins: readonly DesktopTurnPluginCapability[];
  readonly skills: readonly DesktopTurnSkillCapability[];
  readonly runtimeTools: readonly RuntimeTool[];
  readonly runtimeToolBindings: readonly DesktopTurnRuntimeToolBinding[];
}
