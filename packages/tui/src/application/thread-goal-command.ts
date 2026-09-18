export type TuiThreadGoalCommandIntent =
  | { kind: 'help' }
  | { kind: 'view' }
  | {
      kind: 'create';
      objective: string;
      tokenBudget?: number | null;
    }
  | {
      kind: 'budget';
      tokenBudget: number | null;
    }
  | { kind: 'clear' }
  | { kind: 'edit' }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'error'; message: string };

export const TUI_THREAD_GOAL_COMMAND_HELP =
  '/goal: show the current Goal and its latest status.\n' +
  '/goal <objective>: set a persistent objective the agent will pursue across turns.\n' +
  '/goal <objective> budget=50K: set objective and token budget in one shot.\n' +
  '/goal budget=50K: set/change the token budget on the current goal.\n' +
  '/goal budget=clear: remove the token budget (uncapped).\n' +
  '/goal clear: remove the current goal.\n' +
  '/goal edit: edit the objective inline.\n' +
  '/goal pause: pause auto-continuation.\n' +
  '/goal resume: resume a paused or blocked goal.';

/**
 * Boundary characters that may separate a relaxed `budget=<value>`
 * directive from objective text: whitespace, CJK punctuation & kana
 * (U+3000–U+30FF), CJK ideographs (U+4E00–U+9FFF), full/half-width forms
 * (U+FF00–U+FFEF) and the horizontal ellipsis. Deliberately an ALLOWLIST —
 * ASCII punctuation is not a boundary, so technical text keeps its tail.
 * Mirrors the Desktop parser in `@mavis/ui` `lib/thread-goal-slash.ts`.
 */
const RELAXED_BOUNDARY = '[\\s\\u2026\\u3000-\\u30FF\\u4E00-\\u9FFF\\uFF00-\\uFFEF]';
const LEADING_BUDGET_RE = new RegExp(`^budget=([A-Za-z0-9.]+)(?=$|${RELAXED_BOUNDARY})`, 'iu');
const TRAILING_BUDGET_RE = new RegExp(`(^|${RELAXED_BOUNDARY})budget=([A-Za-z0-9.]+)$`, 'iu');
const SEPARATOR_BEFORE_RE = /[\s…、。！，：；？]+$/u;
const SEPARATOR_AFTER_RE = /^[\s…、。！，：；？]+/u;

function parseTrailingBudget(
  body: string,
): { value: number | null | 'invalid'; head: string } | null {
  const trimmed = body.trimEnd();
  const lastSpace = trimmed.search(/\s\S*$/);
  const tail = lastSpace === -1 ? trimmed : trimmed.slice(lastSpace + 1);
  if (!/^budget=[A-Za-z0-9.]*$/i.test(tail)) return null;
  const rawValue = tail.slice('budget='.length);
  const head = lastSpace === -1 ? '' : trimmed.slice(0, lastSpace).trimEnd();
  return { value: parseBudgetValue(rawValue), head };
}

type BudgetDirectiveExtraction =
  | { kind: 'none' }
  | { kind: 'invalid' }
  | { kind: 'double' }
  | { kind: 'value'; value: number | null; objective: string };

/**
 * Extract a `budget=<value>` directive from the start or end of a body.
 * Strict trailing token first (may surface `'invalid'`), then the relaxed
 * trailing form (CJK boundary, valid values only), then the relaxed
 * leading form; a valid directive at both ends is `'double'`.
 */
function extractBudgetDirective(body: string): BudgetDirectiveExtraction {
  const trimmed = body.trim();
  const strict = parseTrailingBudget(trimmed);
  if (strict?.value === 'invalid') return { kind: 'invalid' };

  let value: number | null | undefined;
  let head: string | undefined;
  if (strict) {
    value = strict.value;
    head = strict.head;
  } else {
    const relaxed = TRAILING_BUDGET_RE.exec(trimmed);
    if (relaxed) {
      const parsed = parseBudgetValue(relaxed[2] ?? '');
      if (parsed !== 'invalid') {
        value = parsed;
        head = trimmed.slice(0, relaxed.index + (relaxed[1] ?? '').length);
      }
    }
  }
  if (head !== undefined && value !== undefined) {
    const objective = head.replace(SEPARATOR_BEFORE_RE, '').trim();
    const leftover = LEADING_BUDGET_RE.exec(objective);
    if (leftover && parseBudgetValue(leftover[1] ?? '') !== 'invalid') {
      return { kind: 'double' };
    }
    return { kind: 'value', value, objective };
  }

  const leading = LEADING_BUDGET_RE.exec(trimmed);
  if (leading) {
    const parsed = parseBudgetValue(leading[1] ?? '');
    if (parsed !== 'invalid') {
      const objective = trimmed.slice(leading[0].length).replace(SEPARATOR_AFTER_RE, '').trim();
      return { kind: 'value', value: parsed, objective };
    }
  }
  return { kind: 'none' };
}

function parseBudgetValue(raw: string): number | null | 'invalid' {
  const value = raw.trim();
  if (!value) return 'invalid';
  const normalized = value.toLowerCase();
  if (
    normalized === 'clear' ||
    normalized === 'null' ||
    normalized === 'none' ||
    normalized === 'off' ||
    value === '0'
  ) {
    return null;
  }
  const match = normalized.match(/^([0-9]+(?:\.[0-9]+)?)([km])?$/);
  if (!match) return 'invalid';
  const [, numberText, suffix] = match;
  const parsed = Number(numberText);
  if (!Number.isFinite(parsed) || parsed <= 0) return 'invalid';
  const multiplier = suffix === 'k' ? 1_000 : suffix === 'm' ? 1_000_000 : 1;
  const result = Math.round(parsed * multiplier);
  return result > 0 ? result : 'invalid';
}

export function parseTuiThreadGoalCommand(rawArgs: string): TuiThreadGoalCommandIntent {
  const tail = rawArgs.trim();
  if (!tail) return { kind: 'view' };

  const firstSpace = tail.search(/\s/);
  const headRaw = firstSpace === -1 ? tail : tail.slice(0, firstSpace);
  const head = headRaw.toLowerCase();

  if (head === 'budget') {
    return {
      kind: 'error',
      message: '/goal budget needs a value: `/goal budget=50K` or `/goal budget=clear`.',
    };
  }
  if (/^budget=[A-Za-z0-9.]*$/i.test(headRaw) && tail.length === headRaw.length) {
    const rawBudget = headRaw.slice('budget='.length);
    const parsed = parseBudgetValue(rawBudget);
    if (parsed === 'invalid') {
      return {
        kind: 'error',
        message: `Bad budget value: use a positive integer, K/M suffix, or 'clear' (got "${rawBudget}").`,
      };
    }
    return { kind: 'budget', tokenBudget: parsed };
  }

  switch (head) {
    case 'clear':
    case 'cancel':
    case 'delete':
      return tail.length > headRaw.length
        ? { kind: 'error', message: '/goal clear takes no arguments.' }
        : { kind: 'clear' };
    case 'edit':
      return tail.length > headRaw.length
        ? { kind: 'error', message: '/goal edit takes no arguments.' }
        : { kind: 'edit' };
    case 'pause':
      return tail.length > headRaw.length
        ? { kind: 'error', message: '/goal pause takes no arguments.' }
        : { kind: 'pause' };
    case 'resume':
      return tail.length > headRaw.length
        ? { kind: 'error', message: '/goal resume takes no arguments.' }
        : { kind: 'resume' };
    case 'help':
      return { kind: 'help' };
    default: {
      const extraction = extractBudgetDirective(tail);
      if (extraction.kind === 'invalid') {
        return {
          kind: 'error',
          message:
            'Bad budget value: use a positive integer, K/M suffix, or `clear`/`null` to remove the cap.',
        };
      }
      if (extraction.kind === 'double') {
        return {
          kind: 'error',
          message: 'budget= is specified more than once: keep a single budget=<value>.',
        };
      }
      if (extraction.kind === 'value') {
        return extraction.objective
          ? { kind: 'create', objective: extraction.objective, tokenBudget: extraction.value }
          : { kind: 'budget', tokenBudget: extraction.value };
      }
      return { kind: 'create', objective: tail };
    }
  }
}
