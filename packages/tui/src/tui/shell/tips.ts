export interface TuiTip {
  readonly id: string;
  readonly command: string;
  readonly text: string;
  readonly shortText: string;
  readonly weight?: number;
}

interface TuiTipDefinition {
  readonly id: string;
  readonly command: string;
  readonly text: string;
  readonly shortText: string;
  readonly weight?: number;
}

const TUI_TIP_DEFINITIONS: readonly TuiTipDefinition[] = [
  {
    id: 'goal',
    command: 'goal',
    text: 'Tip: /goal keeps multi-step work focused on a finish line',
    shortText: 'Tip: /goal tracks multi-step work',
    weight: 2,
  },
  {
    id: 'context',
    command: 'context',
    text: 'Tip: /context shows the current Session context budget',
    shortText: 'Tip: /context shows context',
    weight: 2,
  },
  {
    id: 'steer',
    command: 'steer',
    text: 'Tip: /steer guides a response without interrupting it',
    shortText: 'Tip: /steer guides a live run',
    weight: 2,
  },
  {
    id: 'plugins',
    command: 'plugins',
    text: 'Tip: /plugins manages installed capabilities',
    shortText: 'Tip: /plugins manages Plugins',
    weight: 2,
  },
  {
    id: 'sessions',
    command: 'sessions',
    text: 'Tip: /sessions resumes earlier conversations',
    shortText: 'Tip: /sessions resumes work',
  },
  {
    id: 'fork',
    command: 'fork',
    text: 'Tip: /fork branches the current conversation',
    shortText: 'Tip: /fork branches a Session',
  },
  {
    id: 'rewind',
    command: 'rewind',
    text: 'Tip: /rewind restores an earlier turn',
    shortText: 'Tip: /rewind restores a turn',
  },
  {
    id: 'compact',
    command: 'compact',
    text: 'Tip: /compact frees context in a long conversation',
    shortText: 'Tip: /compact frees context',
  },
  {
    id: 'skills',
    command: 'skills',
    text: 'Tip: /skills lists available Skills',
    shortText: 'Tip: /skills lists Skills',
  },
  {
    id: 'feedback',
    command: 'feedback',
    text: 'Tip: /feedback previews redacted feedback before upload',
    shortText: 'Tip: /feedback previews reports',
  },
];

export function buildTuiTips(): readonly TuiTip[] {
  return TUI_TIP_DEFINITIONS.map((tip) => ({
    id: tip.id,
    command: tip.command,
    text: tip.text,
    shortText: tip.shortText,
    ...(tip.weight === undefined ? {} : { weight: tip.weight }),
  }));
}

export const TUI_TIPS = buildTuiTips();

export const TUI_TIP_ROTATION_INTERVAL_MS = 30_000;

/** Build a deterministic smooth weighted round-robin sequence. */
export function buildWeightedTuiTipRotation(tips: readonly TuiTip[]): readonly TuiTip[] {
  const items = tips.map((tip) => ({
    tip,
    weight: Math.max(1, Math.trunc(tip.weight ?? 1)),
    current: 0,
  }));
  const totalWeight = items.reduce((total, item) => total + item.weight, 0);
  const rotation: TuiTip[] = [];

  for (let index = 0; index < totalWeight; index += 1) {
    let selected = items[0];
    for (const item of items) {
      item.current += item.weight;
      if (!selected || item.current > selected.current) selected = item;
    }
    if (!selected) break;
    selected.current -= totalWeight;
    rotation.push(selected.tip);
  }

  return rotation;
}

const DEFAULT_TUI_TIP_ROTATION = buildWeightedTuiTipRotation(TUI_TIPS);

export function selectTuiTipAt(
  nowMs: number,
  tips: readonly TuiTip[] = TUI_TIPS,
): TuiTip | undefined {
  const rotation = tips === TUI_TIPS ? DEFAULT_TUI_TIP_ROTATION : buildWeightedTuiTipRotation(tips);
  if (rotation.length === 0) return undefined;

  const bucket = Math.floor(nowMs / TUI_TIP_ROTATION_INTERVAL_MS);
  const index = ((bucket % rotation.length) + rotation.length) % rotation.length;
  return rotation[index];
}
