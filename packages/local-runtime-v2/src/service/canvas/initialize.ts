import { LocalCanvasService } from './local-canvas.service.js';
import type { CanvasService, CanvasServiceOptions } from './contracts.js';

function initializeCanvasService(options: CanvasServiceOptions): CanvasService {
  return new LocalCanvasService(options);
}

export interface RuntimeCanvasInitializationOptions {
  readonly db: CanvasServiceOptions['db'];
  readonly compatibility: {
    readonly sessionV2: { readonly canvasAssets: CanvasServiceOptions['assets'] };
  };
  readonly nowMs?: () => number;
}

export interface RuntimeCanvasSessionSystem {
  readonly repositories: { readonly sessions: CanvasServiceOptions['sessions'] };
}

export function initializeRuntimeCanvas(
  options: RuntimeCanvasInitializationOptions,
  sessionSystem: RuntimeCanvasSessionSystem,
): CanvasService {
  const requiredOptions = {
    db: options.db,
    sessions: sessionSystem.repositories.sessions,
    assets: options.compatibility.sessionV2.canvasAssets,
  };
  return options.nowMs
    ? initializeCanvasService({ ...requiredOptions, nowMs: options.nowMs })
    : initializeCanvasService(requiredOptions);
}
