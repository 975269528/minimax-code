import { panelLayout } from '../../widgets/panel-frame.js';
import type { MavisRegion } from '@mavis/config';
import type { Component } from '../../rendering/component.js';
import {
  tuiChalk as chalk,
  tuiColors as colors,
  tuiSelectListTheme as theme,
} from '../../theme/runtime.js';
import { SelectList } from '../../widgets/select-list.js';

const LOGIN_REGIONS: readonly {
  value: MavisRegion;
  label: string;
  description: string;
}[] = [
  { value: 'cn', label: 'China (CN)', description: 'MiniMax China account' },
  { value: 'en', label: 'Global', description: 'MiniMax international account' },
];

export class TuiLoginRegionPicker implements Component {
  readonly fullscreenViewport = true;
  readonly handlesViewportKeys = true;
  private readonly list: SelectList;

  constructor(onSelect: (region: MavisRegion) => void, onCancel: () => void) {
    this.list = new SelectList([...LOGIN_REGIONS], LOGIN_REGIONS.length, theme, {
      minPrimaryColumnWidth: 16,
      maxPrimaryColumnWidth: 24,
    });
    this.list.onSelect = (item) => onSelect(item.value as MavisRegion);
    this.list.onCancel = onCancel;
  }

  handleInput(data: string): void {
    this.list.handleInput(data);
  }

  invalidate(): void {
    this.list.invalidate();
  }

  render(width: number): string[] {
    return this.renderViewport(width, 20);
  }

  renderViewport(width: number, height: number): string[] {
    const layout = panelLayout(width, height, '↑↓ select · Enter continue · Esc cancel');
    const helper =
      layout.bodyHeight >= 4
        ? [chalk.hex(colors.muted)('Only one MiniMax account region can be signed in at a time.')]
        : [];
    return layout.render({
      title: 'Choose account region',
      body: [
        ...helper,
        ...this.list.renderViewport(layout.contentWidth, layout.bodyHeight - helper.length),
      ],
    });
  }
}
