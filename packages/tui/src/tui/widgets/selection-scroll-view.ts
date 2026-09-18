import { ScrollView, type Component, type ScrollViewOptions } from '../engine/public.js';

export class TuiSelectionScrollView extends ScrollView {
  private activeRow: number | undefined;
  private ensureActiveRowOnLayout = false;

  constructor(component: Component, options: ScrollViewOptions = {}) {
    super(component, options);
  }

  setActiveRow(row: number, force = false): void {
    const next = Math.max(0, Math.floor(row));
    if (!force && this.activeRow === next) return;
    this.activeRow = next;
    this.ensureActiveRowOnLayout = true;
  }

  /**
   * Update the semantic row without changing a viewport that the user moved manually.
   * This is used when row coordinates are remeasured but the selected item is unchanged.
   */
  setActiveRowPreservingScroll(row: number): void {
    this.activeRow = Math.max(0, Math.floor(row));
  }

  override updateLayout(
    contentHeight: number,
    viewportHeight: number,
    requestRender: () => void,
  ): void {
    super.updateLayout(contentHeight, viewportHeight, requestRender);
    if (!this.ensureActiveRowOnLayout || this.activeRow === undefined) return;
    this.ensureActiveRowOnLayout = false;
    if (this.activeRow < this.scrollTop) {
      this.scrollTo(this.activeRow, { disableFollow: true });
      return;
    }
    if (this.viewportHeight > 0 && this.activeRow >= this.scrollTop + this.viewportHeight) {
      this.scrollTo(this.activeRow - this.viewportHeight + 1, { disableFollow: true });
    }
  }
}
