import { TuiStatusLinePicker } from '../../features/settings/status-line-picker.js';
import type { TuiInteractionSurface } from '../../shell/interaction-surface.js';
import type { TuiWorkspaceStatusLine } from '../../shell/workspace-status-line.js';
import type { TuiStatusLineItem } from '../../shell/status-line-items.js';

export function showTuiStatusLineSetup(options: {
  readonly statusLine: TuiWorkspaceStatusLine;
  readonly surface: Pick<TuiInteractionSurface, 'show' | 'close' | 'request'>;
  readonly persist?: (items: readonly TuiStatusLineItem[] | undefined) => Promise<void>;
}): void {
  const picker = new TuiStatusLinePicker({
    items: options.statusLine.getConfiguredItems(),
    preview: (items, width, height) => options.statusLine.preview(items, width, height),
    save: async (items) => {
      if (!options.persist) throw new Error('Status line persistence is unavailable');
      await options.persist(items);
      options.statusLine.setConfiguredItems(items);
    },
    onClose: () => {
      options.surface.close(picker);
    },
    requestRender: () => options.surface.request(),
  });
  options.surface.show(picker);
}
