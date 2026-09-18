import { stripAnsi, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '../rendering/text.js';
import { renderTuiActionHint, tuiChalk as chalk, tuiColors as colors } from '../theme/runtime.js';

export type TuiPanelTone = 'signal' | 'warning' | 'error' | 'success';

export interface TuiPanelFrame {
  readonly title: string;
  readonly meta?: string;
  readonly body: readonly string[];
  readonly footer?: string | readonly string[];
}

/** Use the same size budget for content layout and final rendering so borders cannot displace focus or close hints. */
export function panelLayout(width: number, height?: number, footer?: TuiPanelFrame['footer']) {
  const safeWidth = Math.max(0, Math.floor(width));
  const safeHeight = height === undefined ? Infinity : Math.max(0, Math.floor(height));
  const framed = safeWidth >= 12 && safeHeight >= 6;
  const contentWidth = panelContentWidth(safeWidth, framed);
  const footerLines = renderPanelFooter(footer, contentWidth);
  const footerBudget = Math.max(1, Math.floor((safeHeight - 2) / 3));
  const visibleFooter =
    footerLines.length <= footerBudget
      ? footerLines
      : [...footerLines.slice(0, Math.max(0, footerBudget - 1)), ...footerLines.slice(-1)];
  const overhead =
    (framed ? 2 : 1) + visibleFooter.length + (framed && visibleFooter.length ? 1 : 0);
  const bodyHeight = Math.max(0, safeHeight - overhead);
  return {
    contentWidth,
    bodyHeight,
    render(frame: Omit<TuiPanelFrame, 'footer'>, tone: TuiPanelTone = 'signal'): string[] {
      if (!safeWidth || !safeHeight) return [];
      const body = frame.body.slice(0, bodyHeight);
      const header = framed
        ? renderPanelHeader(frame.title, frame.meta, safeWidth, tone)
        : truncateToWidth(chalk.bold.hex(colors[tone])(frame.title), safeWidth, '…');
      const lines = framed
        ? [
            header,
            ...body.map((line) => renderPanelRow(line, safeWidth)),
            ...(visibleFooter.length
              ? [
                  renderPanelDivider(safeWidth),
                  ...visibleFooter.map((line) => renderPanelRow(line, safeWidth)),
                ]
              : []),
            renderPanelBottom(safeWidth),
          ]
        : [header, ...body, ...visibleFooter];
      // In very short windows, prioritize the final cancel/close hint.
      return (
        safeHeight === 1 && visibleFooter.length
          ? visibleFooter.slice(-1)
          : lines.slice(0, safeHeight)
      ).map((line) => truncateToWidth(line, safeWidth, ''));
    },
  };
}

export function renderPanelFrame(
  frame: TuiPanelFrame,
  width: number,
  height?: number,
  tone: TuiPanelTone = 'signal',
): string[] {
  return panelLayout(width, height, frame.footer).render(frame, tone);
}

export function panelContentWidth(width: number, framed = width >= 12): number {
  return Math.max(0, Math.floor(width) - (framed ? 4 : 0));
}

export function renderPanelFooter(footer: TuiPanelFrame['footer'], width: number): string[] {
  if (!footer || width <= 0) return [];
  const entries = typeof footer === 'string' ? [footer] : footer;
  const actions = entries.flatMap((entry) => stripAnsi(entry).split(' · '));
  const exits = actions.filter((action) => /^(?:Esc|Ctrl\+C)\b/iu.test(action));
  const others = actions.filter((action) => !/^(?:Esc|Ctrl\+C)\b/iu.test(action));
  return [[...others, ...exits].join(' · ')].flatMap((entry) => {
    const lines: string[] = [];
    let line = '';
    // Wrap by action groups so Esc close cannot split into separate Esc and close lines.
    for (const action of stripAnsi(entry).split(' · ')) {
      const joined = line ? `${line} · ${action}` : action;
      if (visibleWidth(joined) <= width) {
        line = joined;
        continue;
      }
      if (line) lines.push(line);
      const wrapped = wrapTextWithAnsi(action, Math.max(1, width));
      lines.push(...wrapped.slice(0, -1));
      line = wrapped.at(-1) ?? '';
    }
    if (line) lines.push(line);
    return lines.map(renderTuiActionHint);
  });
}

export function renderPanelHeader(
  title: string,
  meta: string | undefined,
  width: number,
  tone: TuiPanelTone = 'signal',
): string {
  if (width < 12)
    return truncateToWidth(chalk.bold.hex(colors[tone])(title), Math.max(0, width), '');
  const border = chalk.hex(colors.line);
  const metaTitleBudget = meta ? width - visibleWidth(meta) - 8 : 0;
  const titleBudget = metaTitleBudget >= 6 ? metaTitleBudget : width - 6;
  const label = chalk.bold.hex(colors[tone])(truncateToWidth(title, Math.max(1, titleBudget), '…'));
  const start = `${border('╭─')} ${label} `;
  const end = meta ? ` ${chalk.hex(colors.muted)(meta)} ${border('─╮')}` : border('╮');
  if (visibleWidth(start) + visibleWidth(end) <= width) {
    return `${start}${border('─'.repeat(width - visibleWidth(start) - visibleWidth(end)))}${end}`;
  }
  return truncateToWidth(
    `${start}${border('─'.repeat(Math.max(0, width - visibleWidth(start) - 1)))}${border('╮')}`,
    width,
    '',
  );
}

export function renderPanelRow(content: string, width: number): string {
  if (width < 4) return truncateToWidth(content, Math.max(0, width), '');
  const border = chalk.hex(colors.line);
  const contentWidth = Math.max(0, width - 4);
  const fitted = truncateToWidth(content, contentWidth, '');
  return `${border('│')} ${fitted}${' '.repeat(Math.max(0, contentWidth - visibleWidth(fitted)))} ${border('│')}`;
}

export function renderPanelDivider(width: number): string {
  return truncateToWidth(
    chalk.hex(colors.line)(`├${'─'.repeat(Math.max(0, width - 2))}┤`),
    Math.max(0, width),
    '',
  );
}

export function renderPanelBottom(width: number): string {
  return truncateToWidth(
    chalk.hex(colors.line)(`╰${'─'.repeat(Math.max(0, width - 2))}╯`),
    Math.max(0, width),
    '',
  );
}
