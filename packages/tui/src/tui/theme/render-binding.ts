import type { TUI } from '../engine/public.js';
import type { TuiThemeController } from './controller.js';

export function bindThemeRendering(
  controller: TuiThemeController,
  tui: TUI,
  isActive: () => boolean,
): { start(): void } {
  controller.onChange(() => {
    tui.invalidate();
    if (isActive()) tui.requestRender();
  });

  return {
    start(): void {
      void controller.start().catch(() => undefined);
    },
  };
}
