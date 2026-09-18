import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { CellFlags, Ghostty, type GhosttyCell, type GhosttyTerminal } from 'ghostty-web';

const require = createRequire(import.meta.url);
const ghosttyModule = new WebAssembly.Module(
  readFileSync(require.resolve('ghostty-web/ghostty-vt.wasm')),
);

export class VirtualTerminalScreen {
  private readonly terminal: GhosttyTerminal;

  constructor(columns = 80, rows = 24, scrollbackBytes = 1024 * 1024) {
    const ghostty = new Ghostty(
      new WebAssembly.Instance(ghosttyModule, {
        env: { log: () => undefined },
      }),
    );
    this.terminal = ghostty.createTerminal(columns, rows, { scrollbackLimit: scrollbackBytes });
  }

  feed(output: string): void {
    this.terminal.write(output);
  }

  resize(columns: number, rows: number): void {
    this.terminal.resize(columns, rows);
  }

  text(): string {
    const lines: string[] = [];
    for (let row = 0; row < this.terminal.getScrollbackLength(); row += 1) {
      lines.push(cellsToText(this.terminal.getScrollbackLine(row)));
    }
    for (let row = 0; row < this.terminal.rows; row += 1) {
      lines.push(cellsToText(this.terminal.getLine(row)));
    }
    while (lines.at(-1) === '') lines.pop();
    return lines.join('\n');
  }

  viewportText(): string {
    const lines = Array.from({ length: this.terminal.rows }, (_, row) =>
      cellsToText(this.terminal.getLine(row)),
    );
    return lines.join('\n');
  }

  cursor(): { x: number; y: number; visible: boolean } {
    return this.terminal.getCursor();
  }

  isItalic(row: number, column: number): boolean {
    const cell = this.terminal.getLine(row)?.[column];
    return Boolean(cell && (cell.flags & CellFlags.ITALIC) !== 0);
  }

  isUnderline(row: number, column: number): boolean {
    const cell = this.terminal.getLine(row)?.[column];
    return Boolean(cell && (cell.flags & CellFlags.UNDERLINE) !== 0);
  }

  backgroundRgb(row: number, column: number): { r: number; g: number; b: number } | undefined {
    const cell = this.terminal.getLine(row)?.[column];
    return cell ? { r: cell.bg_r, g: cell.bg_g, b: cell.bg_b } : undefined;
  }

  dispose(): void {
    this.terminal.free();
  }
}

function cellsToText(cells: GhosttyCell[] | null): string {
  if (!cells) return '';
  let line = '';
  for (const cell of cells) {
    if (cell.codepoint === 0) {
      if (cell.width > 0) line += ' ';
      continue;
    }
    line += String.fromCodePoint(cell.codepoint);
  }
  return line.replace(/\s+$/u, '');
}
