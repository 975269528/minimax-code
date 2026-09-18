import {
  panelContentWidth,
  renderPanelFrame,
  type TuiPanelTone,
} from '../../widgets/panel-frame.js';
import { truncateToWidth, visibleWidth } from '../../rendering/text.js';
import { tuiChalk as chalk, tuiColors as colors } from '../../theme/runtime.js';

export type TuiDecisionTone = TuiPanelTone;

export interface TuiQuestionnaireFrame {
  readonly title: string;
  readonly meta?: string;
  readonly navigation?: readonly string[];
  readonly body: readonly string[];
  readonly footer?: string;
}

export function decisionContentWidth(width: number): number {
  const safeWidth = Math.max(0, width);
  if (safeWidth <= 1) return 0;
  return safeWidth - (safeWidth < 36 ? 1 : 2);
}

export function renderDecisionHeading(
  label: string,
  meta: string | undefined,
  width: number,
  tone: TuiDecisionTone,
): string {
  const safeWidth = Math.max(0, width);
  const renderedLabel = chalk.bold.hex(colors[tone])(label);
  if (!meta) return truncateToWidth(renderedLabel, safeWidth, '');

  const renderedMeta = chalk.hex(colors.muted)(meta);
  const gap = safeWidth - visibleWidth(label) - visibleWidth(meta);
  if (gap >= 2) return `${renderedLabel}${' '.repeat(gap)}${renderedMeta}`;
  return truncateToWidth(`${renderedLabel} · ${renderedMeta}`, safeWidth, '');
}

export function renderDecisionFrame(
  lines: readonly string[],
  width: number,
  tone: TuiDecisionTone,
): string[] {
  const safeWidth = Math.max(0, width);
  if (safeWidth === 0) return [];
  const rail = chalk.hex(colors[tone])('│');
  if (safeWidth === 1) return lines.map(() => rail);
  const contentWidth = decisionContentWidth(safeWidth);
  const gap = safeWidth < 36 ? '' : ' ';
  return lines.map((line) => `${rail}${gap}${truncateToWidth(line, contentWidth, '')}`);
}

export function questionnaireFrameContentWidth(width: number): number {
  return panelContentWidth(width);
}

export function renderQuestionnaireFrame(
  frame: TuiQuestionnaireFrame,
  width: number,
  tone: TuiDecisionTone,
): string[] {
  return renderPanelFrame(
    {
      ...frame,
      body: [...(frame.navigation ?? []), ...frame.body],
    },
    width,
    undefined,
    tone,
  );
}
