import {
  SelectList as FoundationSelectList,
  type SelectItem,
  type SelectListLayoutOptions,
  type SelectListTheme,
} from '../engine/public.js';

export class SelectList extends FoundationSelectList {
  private readonly selection: { text: string };
  constructor(
    items: SelectItem[],
    maxVisible: number,
    theme: SelectListTheme,
    layout: SelectListLayoutOptions = {},
  ) {
    const selection = { text: '' };
    const paintSelection = (paint: (text: string) => string) => (text: string) => {
      const rendered = paint(text.replace(/^→ /u, '› '));
      selection.text = rendered;
      return rendered;
    };
    super(
      items,
      maxVisible,
      {
        ...theme,
        selectedText: paintSelection(theme.selectedText),
        selectedPrefix: paintSelection(theme.selectedPrefix),
      },
      {
        minPrimaryColumnWidth: 12,
        maxPrimaryColumnWidth: 32,
        ...layout,
      },
    );
    this.selection = selection;
  }

  /** Locate focus from the selected row's rendered result; do not make the outer container guess which arrow belongs to the content. */
  renderViewport(width: number, height: number): string[] {
    if (height <= 0) return [];
    this.selection.text = '';
    const lines = this.render(width);
    const selected = this.selection.text
      ? lines.findIndex((line) => line.includes(this.selection.text))
      : 0;
    const start = Math.max(0, Math.min(selected - Math.floor(height / 2), lines.length - height));
    return lines.slice(start, start + height);
  }
}

export type {
  SelectItem,
  SelectListLayoutOptions,
  SelectListTheme,
  SelectListTruncatePrimaryContext,
} from '../engine/public.js';
