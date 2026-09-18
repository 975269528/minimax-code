import { describe, expect, it } from 'vitest';

import {
  CURSOR_MARKER,
  Editor,
  Input,
  SelectList,
  Text,
  TuiMainScreen,
  type Component,
  type TUI,
  visibleWidth,
} from '../../src/tui/engine/public.js';
import { VirtualTerminal } from '../pi-084-upstream/virtual-terminal.js';

const passthrough = (value: string): string => value;
const selectListTheme = {
  selectedPrefix: passthrough,
  selectedText: passthrough,
  description: passthrough,
  scrollInfo: passthrough,
  noMatch: passthrough,
};

class RecordingVirtualTerminal extends VirtualTerminal {
  private writes: string[] = [];

  override write(data: string): void {
    this.writes.push(data);
    super.write(data);
  }

  takeWrites(): string {
    const output = this.writes.join('');
    this.writes = [];
    return output;
  }
}

class MutableLines implements Component {
  lines: string[] = [];

  render(): string[] {
    return [...this.lines];
  }

  invalidate(): void {}
}

describe('MCode Pi Engine local deltas', () => {
  it('fits Text padding within narrow terminal widths', () => {
    const text = new Text('content', 2, 0);

    for (const width of [1, 2, 3, 4]) {
      expect(text.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
    }
  });

  it('preserves native scrollback when transient rows shrink above the viewport', async () => {
    const terminal = new RecordingVirtualTerminal(40, 5);
    const tui = new TuiMainScreen(terminal);
    const component = new MutableLines();
    component.lines = [
      'header',
      'activity-1',
      'activity-2',
      'activity-3',
      'activity-4',
      'status',
      'composer',
    ];
    tui.addChild(component);

    tui.renderNow();
    await terminal.flush();
    terminal.takeWrites();

    component.lines = ['header', 'status', 'composer'];
    tui.renderNow();
    await terminal.flush();

    const writes = terminal.takeWrites();
    expect(writes).toContain('\x1b[2J\x1b[H');
    expect(writes).not.toContain('\x1b[3J');
    expect(terminal.getScrollBuffer()).toContain('activity-1');
    expect(terminal.getViewport()).toEqual(['header', 'status', 'composer', '', '']);
    expect(tui.fullRedraws).toBe(2);
  });

  it('renders an urgent product interaction without resetting Main diff state', async () => {
    const terminal = new RecordingVirtualTerminal(40, 5);
    const tui = new TuiMainScreen(terminal);
    const component = new MutableLines();
    component.lines = ['stable', 'tail'];
    tui.addChild(component);

    tui.renderNow();
    await terminal.flush();
    terminal.takeWrites();

    component.lines.push('interaction');
    tui.requestImmediateRender();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await terminal.flush();

    const writes = terminal.takeWrites();
    expect(writes).toContain('interaction');
    expect(writes).not.toContain('\x1b[2J');
    expect(writes).not.toContain('\x1b[3J');
  });

  it('keeps OSC 133 zone sentinels out of regular-mode terminal writes', async () => {
    const terminal = new RecordingVirtualTerminal(40, 5);
    const tui = new TuiMainScreen(terminal);
    const component = new MutableLines();
    const zoneStart = '\x1b]133;A\x07';
    const zoneClose = '\x1b]133;B\x07\x1b]133;C\x07';
    component.lines = [`${zoneStart}user prompt`, `${zoneClose}assistant reply`, 'composer'];
    tui.addChild(component);

    tui.renderNow();
    await terminal.flush();
    const initialWrites = terminal.takeWrites();
    expect(initialWrites).toContain('user prompt');
    expect(initialWrites).toContain('assistant reply');
    expect(initialWrites).not.toContain('\x1b]133;');

    component.lines = [`${zoneStart}user prompt`, `${zoneClose}assistant reply updated`, 'composer'];
    tui.renderNow();
    await terminal.flush();
    const diffWrites = terminal.takeWrites();
    expect(diffWrites).toContain('assistant reply updated');
    expect(diffWrites).not.toContain('\x1b]133;');
  });

  it('limits Input extensions to prompt, mask, and paste transformation', () => {
    const input = new Input({
      prompt: 'Search: ',
      mask: '•',
      transformPaste: (value) => value.replace(/\s+/gu, ' '),
    });

    input.handleInput('\u001B[200~secret\nvalue\u001B[201~');
    input.focused = true;

    const rendered = input.render(30)[0] ?? '';
    expect(input.getValue()).toBe('secret value');
    expect(rendered).toContain('Search: ');
    expect(rendered).toContain('•');
    expect(rendered).not.toContain('secret');
    expect(rendered).toContain(CURSOR_MARKER);
  });

  it('retains grouped SelectList headings while using Pi filtering and single-line descriptions', () => {
    const list = new SelectList(
      [
        {
          value: 'docs',
          label: 'Documents',
          description: 'Create, edit, search and share documents.',
          groupLabel: 'Files',
        },
        {
          value: 'code',
          label: 'Code',
          description: 'Inspect and modify source code.',
          groupLabel: 'Files',
        },
      ],
      2,
      selectListTheme,
    );

    list.setFilter('docs');
    const rendered = list.render(48);

    expect(rendered.join('\n')).toContain('Files');
    expect(rendered.join('\n')).toContain('Documents');
    expect(rendered.join('\n')).not.toContain('Code');
    expect(rendered).toHaveLength(2);
    expect(rendered.every((line) => visibleWidth(line) <= 48)).toBe(true);
  });

  it('exposes only the generic Editor hooks required by a product Draft adapter', () => {
    const tui = {
      terminal: { rows: 24 },
      requestRender: () => undefined,
    } as TUI;
    const editor = new Editor(tui, { borderColor: passthrough, selectList: selectListTheme }, {
      transformPaste: (value) => value.replaceAll('\r', ''),
    });
    let extensionState = 'empty';
    editor.captureUndoExtensionState = () => extensionState;
    editor.restoreUndoExtensionState = (state) => {
      extensionState = String(state);
    };

    editor.handleInput('a');
    extensionState = 'typed';
    editor.handleInput('\x1f');
    expect(editor.getText()).toBe('');
    expect(extensionState).toBe('empty');

    editor.onPaste = (value) => value.endsWith('.png');
    editor.handleInput('\u001B[200~/tmp/image.png\r\u001B[201~');
    expect(editor.getText()).toBe('');

    const pasted = 'x'.repeat(1_001);
    editor.onPaste = undefined;
    editor.handleInput(`\u001B[200~${pasted}\u001B[201~`);
    const snapshot = editor.captureState();
    editor.setText('replacement');
    expect(editor.restoreState(snapshot)).toBe(true);
    expect(editor.getExpandedText()).toBe(pasted);

    let submitted = '';
    editor.onSubmit = (value) => {
      submitted = value;
    };
    editor.submit();
    expect(submitted).toBe(pasted);
  });
});
