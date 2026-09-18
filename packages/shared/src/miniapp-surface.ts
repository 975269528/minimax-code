/** Renderer-safe Mini App metadata. Runtime launch coordinates never cross this contract. */
export type MiniAppRuntimeStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed';

export interface MiniAppSurfaceSummary {
  readonly pluginId: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly iconUrl?: string;
  readonly runtime: {
    readonly kind: 'process';
    readonly status: MiniAppRuntimeStatus;
    readonly errorCode?: string;
  };
}

export interface MiniAppSurfaceTabSummary {
  readonly tabId: number;
  readonly title: string;
  readonly surfaceKind: 'miniapp';
  readonly miniApp: MiniAppSurfaceSummary;
}

export type MiniAppSurfaceErrorCode =
  | 'invalid_request'
  | 'runtime_unavailable'
  | 'not_found'
  | 'busy'
  | 'refresh_failed'
  | 'stop_failed'
  | 'start_failed';

/** Bounded, renderer-safe explanation for a retryable Mini App busy failure. */
export type MiniAppSurfaceBusyReason = 'capacity_busy' | 'operation_busy';

export type MiniAppListResponse =
  | { readonly success: true; readonly miniApps: readonly MiniAppSurfaceSummary[] }
  | { readonly success: false; readonly code: MiniAppSurfaceErrorCode };

export type MiniAppOpenResponse =
  | { readonly success: true; readonly tab: MiniAppSurfaceTabSummary }
  | {
      readonly success: false;
      readonly code: 'busy';
      readonly busyReason?: MiniAppSurfaceBusyReason;
    }
  | {
      readonly success: false;
      readonly code: Exclude<MiniAppSurfaceErrorCode, 'busy'>;
      readonly busyReason?: never;
    };

export type MiniAppControlResponse =
  | { readonly success: true }
  | { readonly success: false; readonly code: MiniAppSurfaceErrorCode };
