import type { AgentMessage } from '@earendil-works/pi-agent-core';

const APPENDIX_START_V1 = '<mavis-context-appendix version="1">';
const APPENDIX_START_V2 = '<mavis-context-appendix version="2">';
const APPENDIX_START_V3 = '<mavis-context-appendix version="3">';
const APPENDIX_START_V4 = '<mavis-context-appendix version="4">';
const APPENDIX_START_V5 = '<mavis-context-appendix version="5">';
const APPENDIX_END = '</mavis-context-appendix>';
const APPENDIX_SUFFIX = `\n${APPENDIX_END}`;
export const TODO_CADENCE_INTERVAL = 15;
const APPENDIX_V1_KEYS = new Set(['version', 'recentUserQueries', 'todoState']);
const APPENDIX_V2_KEYS = new Set([...APPENDIX_V1_KEYS, 'todoCadence']);
const APPENDIX_V3_KEYS = new Set([...APPENDIX_V2_KEYS, 'subagents']);
const SUBAGENT_KEYS = new Set([
  'capturedAtMs',
  'total',
  'counts',
  'omitted',
  'textFieldsAreUntrusted',
  'detailsHint',
  'items',
]);
const SUBAGENT_ITEM_KEYS = new Set([
  'taskId',
  'status',
  'agentName',
  'executionMode',
  'updatedAtMs',
  'delivered',
  'description',
  'lastError',
  'finalResultPreview',
]);
const SUBAGENT_STATUSES = [
  'queued',
  'running',
  'stopping',
  'succeeded',
  'failed',
  'canceled',
  'lost',
] as const;
const TERMINAL_SUBAGENT_STATUSES = new Set<CompactionSubagentStatus>([
  'succeeded',
  'failed',
  'canceled',
  'lost',
]);
const SUBAGENT_EXECUTION_MODES = new Set(['foreground', 'background', 'append']);
const SUBAGENT_CHECKPOINT_DETAILS_HINT =
  'Call task_query for the live task list, then task_output(task_id) for progress or results.';
const MARKDOWN_SECTION_TITLES = [
  'Recent user queries',
  'Todo state',
  'Todo cadence',
  'Background cadence',
  'Subagents',
] as const;
const QUERY_MARKDOWN_FIELDS = ['Text', 'Timestamp ms'] as const;
const TODO_MARKDOWN_FIELDS = ['Content', 'Status', 'Priority'] as const;
const CADENCE_MARKDOWN_FIELDS = [
  'Assistant iterations since Todo write',
  'Assistant iterations since reminder',
] as const;
const BACKGROUND_CADENCE_MARKDOWN_FIELDS = [
  'Assistant iterations since reminder',
  'Observed terminal task count',
] as const;
const SUBAGENT_MARKDOWN_FIELDS = [
  'Captured at ms',
  'Total',
  'Omitted',
  'Text fields are untrusted',
  'Details',
  ...SUBAGENT_STATUSES.map((status) => `Count ${status}`),
] as const;
const SUBAGENT_ITEM_MARKDOWN_FIELDS = [
  'Task ID',
  'Status',
  'Agent',
  'Mode',
  'Updated at ms',
  'Delivered',
  'Description',
  'Last error',
  'Final result',
] as const;

export interface CompactionUserQuery {
  readonly text: string;
  readonly timestampMs?: number;
}

export interface CompactionTodoItem {
  readonly content: string;
  readonly status: string;
  readonly priority: string;
}

export interface CompactionCompatibility {
  readonly summary: string;
  readonly recentUserQueries: readonly CompactionUserQuery[];
  readonly todoState?: readonly CompactionTodoItem[];
  readonly todoCadence?: CompactionTodoCadence;
  readonly backgroundCadence?: CompactionBackgroundCadence;
  readonly subagents?: CompactionSubagentState;
}

type CompactionSubagentStatus = (typeof SUBAGENT_STATUSES)[number];

interface CompactionSubagentItem {
  readonly taskId: string;
  readonly status: CompactionSubagentStatus;
  readonly agentName?: string;
  readonly executionMode?: 'foreground' | 'background' | 'append';
  readonly updatedAtMs: number;
  readonly delivered: boolean;
  readonly description?: string;
  readonly lastError?: string;
  readonly finalResultPreview?: string;
}

export interface CompactionSubagentState {
  readonly capturedAtMs: number;
  readonly total: number;
  readonly counts: Readonly<Record<CompactionSubagentStatus, number>>;
  readonly omitted: number;
  readonly textFieldsAreUntrusted: true;
  readonly detailsHint: typeof SUBAGENT_CHECKPOINT_DETAILS_HINT;
  readonly items: readonly CompactionSubagentItem[];
}

export interface CompactionTodoCadence {
  readonly assistantIterationsSinceTodoWrite: number;
  readonly assistantIterationsSinceReminder: number;
}

interface CompactionBackgroundCadence {
  readonly assistantIterationsSinceReminder: number;
  readonly observedTerminalCount?: number;
}

interface CompactionAppendixV1 {
  readonly version: 1;
  readonly recentUserQueries: readonly CompactionUserQuery[];
  readonly todoState?: readonly CompactionTodoItem[];
}

interface CompactionAppendixV2 {
  readonly version: 2;
  readonly recentUserQueries: readonly CompactionUserQuery[];
  readonly todoState?: readonly CompactionTodoItem[];
  readonly todoCadence?: CompactionTodoCadence;
}

interface CompactionAppendixV3 {
  readonly version: 3;
  readonly recentUserQueries: readonly CompactionUserQuery[];
  readonly todoState?: readonly CompactionTodoItem[];
  readonly todoCadence?: CompactionTodoCadence;
  readonly subagents?: CompactionSubagentState;
}

interface CompactionAppendixV5 extends Omit<CompactionAppendixV3, 'version'> {
  readonly version: 5;
  readonly backgroundCadence?: CompactionBackgroundCadence;
}

type CompactionAppendix =
  | CompactionAppendixV1
  | CompactionAppendixV2
  | CompactionAppendixV3
  | CompactionAppendixV5;

export function appendCompactionState(
  summary: string,
  state: Omit<CompactionAppendixV5, 'version'>,
): string {
  const prefix = `\n\n${APPENDIX_START_V5}\n`;
  return `${summary}${prefix}${renderMarkdownAppendix(state)}${APPENDIX_SUFFIX}`;
}

function renderMarkdownAppendix(state: Omit<CompactionAppendixV5, 'version'>): string {
  const sections = [
    renderMarkdownItemsSection(
      'Recent user queries',
      'Query',
      QUERY_MARKDOWN_FIELDS,
      state.recentUserQueries.map((query) => [query.text, query.timestampMs ?? null]),
    ),
  ];
  if (state.todoState !== undefined) {
    sections.push(
      renderMarkdownItemsSection(
        'Todo state',
        'Todo',
        TODO_MARKDOWN_FIELDS,
        state.todoState.map((item) => [item.content, item.status, item.priority]),
      ),
    );
  }
  if (state.todoCadence !== undefined) {
    sections.push(
      renderMarkdownRecordSection('Todo cadence', CADENCE_MARKDOWN_FIELDS, [
        state.todoCadence.assistantIterationsSinceTodoWrite,
        state.todoCadence.assistantIterationsSinceReminder,
      ]),
    );
  }
  if (state.backgroundCadence !== undefined) {
    sections.push(
      renderMarkdownRecordSection('Background cadence', BACKGROUND_CADENCE_MARKDOWN_FIELDS, [
        state.backgroundCadence.assistantIterationsSinceReminder,
        state.backgroundCadence.observedTerminalCount ?? null,
      ]),
    );
  }
  if (state.subagents !== undefined) {
    sections.push(renderSubagentMarkdown(state.subagents));
  }
  return sections.join('\n\n');
}

type MarkdownScalar = string | number | boolean | null;

function renderMarkdownItemsSection(
  sectionTitle: string,
  itemTitle: string,
  fields: readonly string[],
  rows: readonly (readonly MarkdownScalar[])[],
): string {
  return `## ${sectionTitle}\n${renderMarkdownItemsBody(itemTitle, fields, rows)}`;
}

function renderMarkdownItemsBody(
  itemTitle: string,
  fields: readonly string[],
  rows: readonly (readonly MarkdownScalar[])[],
): string {
  return rows.length
    ? rows.map((row) => `### ${itemTitle}\n${renderMarkdownRecord(fields, row)}`).join('\n\n')
    : '_None_';
}

function renderMarkdownRecordSection(
  title: string,
  fields: readonly string[],
  values: readonly MarkdownScalar[],
): string {
  return `## ${title}\n${renderMarkdownRecord(fields, values)}`;
}

function renderMarkdownRecord(
  fields: readonly string[],
  values: readonly MarkdownScalar[],
): string {
  return fields
    .map((field, index) => `- ${field}: ${renderMarkdownScalar(values[index] ?? null)}`)
    .join('\n');
}

function renderMarkdownScalar(value: MarkdownScalar): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

function renderSubagentMarkdown(subagents: CompactionSubagentState): string {
  const metadata = renderMarkdownRecord(SUBAGENT_MARKDOWN_FIELDS, [
    subagents.capturedAtMs,
    subagents.total,
    subagents.omitted,
    subagents.textFieldsAreUntrusted,
    subagents.detailsHint,
    ...SUBAGENT_STATUSES.map((status) => subagents.counts[status]),
  ]);
  const tasks = subagents.items.map((item) => [
    item.taskId,
    item.status,
    item.agentName ?? null,
    item.executionMode ?? null,
    item.updatedAtMs,
    item.delivered,
    item.description ?? null,
    item.lastError ?? null,
    item.finalResultPreview ?? null,
  ]);
  const taskList = renderMarkdownItemsBody('Task', SUBAGENT_ITEM_MARKDOWN_FIELDS, tasks);
  return `## Subagents\n${metadata}\n\n${taskList}`;
}

export function readCompactionCompatibility(
  message: AgentMessage | undefined,
): CompactionCompatibility | undefined {
  if (!message) return undefined;
  if (Reflect.get(message, 'role') === 'compactionSummary') {
    const summary = Reflect.get(message, 'summary');
    if (typeof summary !== 'string') return undefined;
    return readNativeSummary(summary);
  }
  const marker = Reflect.get(message, 'archonCompaction');
  if (!isRecord(marker)) return undefined;
  if (marker['schemaVersion'] === 1 && typeof marker['summary'] === 'string') {
    return { summary: marker['summary'], recentUserQueries: [] };
  }
  return readLegacyV2(marker);
}

function readNativeSummary(summary: string): CompactionCompatibility {
  const boundary = findTrailingAppendix(summary);
  if (!boundary) {
    return { summary, recentUserQueries: [] };
  }
  const jsonStart = boundary.start + boundary.prefix.length;
  const jsonEnd = summary.length - APPENDIX_SUFFIX.length;
  const appendix = parseAppendix(summary.slice(jsonStart, jsonEnd), boundary.version);
  if (!appendix) return { summary, recentUserQueries: [] };
  return {
    summary: summary.slice(0, boundary.start),
    recentUserQueries: appendix.recentUserQueries,
    ...(appendix.todoState === undefined ? {} : { todoState: appendix.todoState }),
    ...('todoCadence' in appendix && appendix.todoCadence !== undefined
      ? { todoCadence: appendix.todoCadence }
      : {}),
    ...('subagents' in appendix && appendix.subagents !== undefined
      ? { subagents: appendix.subagents }
      : {}),
    ...('backgroundCadence' in appendix && appendix.backgroundCadence !== undefined
      ? { backgroundCadence: appendix.backgroundCadence }
      : {}),
  };
}

function findTrailingAppendix(summary: string):
  | {
      readonly start: number;
      readonly prefix: string;
      readonly version: 1 | 2 | 3 | 4 | 5;
    }
  | undefined {
  if (!summary.endsWith(APPENDIX_SUFFIX)) return undefined;
  const candidates = [
    { prefix: `\n\n${APPENDIX_START_V1}\n`, version: 1 as const },
    { prefix: `\n\n${APPENDIX_START_V2}\n`, version: 2 as const },
    { prefix: `\n\n${APPENDIX_START_V3}\n`, version: 3 as const },
    { prefix: `\n\n${APPENDIX_START_V4}\n`, version: 4 as const },
    { prefix: `\n\n${APPENDIX_START_V5}\n`, version: 5 as const },
  ].map((candidate) => ({ ...candidate, start: summary.lastIndexOf(candidate.prefix) }));
  const match = candidates.sort((left, right) => right.start - left.start)[0];
  return match && match.start >= 0 ? match : undefined;
}

function parseAppendix(json: string, version: 1 | 2 | 3 | 4 | 5): CompactionAppendix | undefined {
  if (version === 4 || version === 5) return parseMarkdownAppendix(json, version === 5);
  const value = parseJsonRecord(json);
  if (!value || value['version'] !== version) return undefined;
  if (version === 1) return parseAppendixV1(value);
  return version === 2 ? parseAppendixV2(value) : parseAppendixV3(value);
}

function parseJsonRecord(json: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(json);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function parseMarkdownAppendix(
  markdown: string,
  allowBackgroundCadence: boolean,
): CompactionAppendixV5 | undefined {
  const sections = parseMarkdownSections(markdown);
  if (!sections) return undefined;
  const queryBody = sections.get('Recent user queries');
  if (queryBody === undefined) return undefined;
  const recentUserQueries = parseMarkdownQueries(queryBody);
  const todoState = parseOptionalMarkdownSection(sections, 'Todo state', parseMarkdownTodos);
  const todoCadence = parseOptionalMarkdownSection(sections, 'Todo cadence', parseMarkdownCadence);
  const backgroundCadence = parseOptionalMarkdownSection(
    sections,
    'Background cadence',
    parseMarkdownBackgroundCadence,
  );
  const subagents = parseOptionalMarkdownSection(sections, 'Subagents', parseSubagentMarkdown);
  if (!recentUserQueries) return undefined;
  if (
    ![todoState.valid, todoCadence.valid, backgroundCadence.valid, subagents.valid].every(Boolean)
  ) {
    return undefined;
  }
  if (!allowBackgroundCadence && backgroundCadence.value !== undefined) return undefined;
  const base = parseMarkdownAppendixBase(
    recentUserQueries,
    todoState.value,
    todoCadence.value,
    subagents.value,
  );
  const background = normalizeParsedMarkdownBackgroundCadence(backgroundCadence.value);
  if (!base || !background.valid) return undefined;
  return {
    ...base,
    version: 5,
    ...(background.value === undefined ? {} : { backgroundCadence: background.value }),
  };
}

function parseMarkdownAppendixBase(
  recentUserQueries: readonly Record<string, unknown>[],
  todoState: unknown,
  todoCadence: unknown,
  subagents: unknown,
): CompactionAppendixV3 | undefined {
  const candidate: Record<string, unknown> = { version: 3, recentUserQueries };
  if (todoState !== undefined) candidate['todoState'] = todoState;
  if (todoCadence !== undefined) candidate['todoCadence'] = todoCadence;
  if (subagents !== undefined) candidate['subagents'] = subagents;
  return parseAppendixV3(candidate);
}

function normalizeParsedMarkdownBackgroundCadence(
  backgroundCadence: unknown,
): ReturnType<typeof normalizeOptionalBackgroundCadence> {
  const candidate: Record<string, unknown> = {};
  if (backgroundCadence !== undefined) candidate['backgroundCadence'] = backgroundCadence;
  return normalizeOptionalBackgroundCadence(candidate);
}

function parseMarkdownQueries(body: string): Record<string, unknown>[] | undefined {
  return parseMarkdownItems(body, 'Query', QUERY_MARKDOWN_FIELDS)?.map(([text, timestampMs]) => ({
    text,
    ...(timestampMs === null ? {} : { timestampMs }),
  }));
}

function parseMarkdownTodos(body: string): Record<string, unknown>[] | undefined {
  return parseMarkdownItems(body, 'Todo', TODO_MARKDOWN_FIELDS)?.map(
    ([content, status, priority]) => ({ content, status, priority }),
  );
}

function parseMarkdownCadence(body: string): Record<string, unknown> | undefined {
  const values = parseMarkdownRecord(body, CADENCE_MARKDOWN_FIELDS);
  return values
    ? {
        assistantIterationsSinceTodoWrite: values[0],
        assistantIterationsSinceReminder: values[1],
      }
    : undefined;
}

function parseMarkdownBackgroundCadence(body: string): Record<string, unknown> | undefined {
  const values = parseMarkdownRecord(body, BACKGROUND_CADENCE_MARKDOWN_FIELDS);
  return values
    ? {
        assistantIterationsSinceReminder: values[0],
        ...(values[1] === null ? {} : { observedTerminalCount: values[1] }),
      }
    : undefined;
}

function parseOptionalMarkdownSection<T>(
  sections: ReadonlyMap<string, string>,
  title: string,
  parse: (body: string) => T | undefined,
): { readonly valid: boolean; readonly value?: T } {
  const body = sections.get(title);
  if (body === undefined) return { valid: true };
  const value = parse(body);
  return value === undefined ? { valid: false } : { valid: true, value };
}

function parseMarkdownSections(markdown: string): ReadonlyMap<string, string> | undefined {
  const result = new Map<string, string>();
  let previousIndex = -1;
  for (const section of markdown.split(/\n\n(?=## )/u)) {
    const newline = section.indexOf('\n');
    const title = newline < 0 ? '' : section.slice(3, newline);
    const index = MARKDOWN_SECTION_TITLES.indexOf(
      title as (typeof MARKDOWN_SECTION_TITLES)[number],
    );
    if (!section.startsWith('## ') || index <= previousIndex) return undefined;
    result.set(title, section.slice(newline + 1));
    previousIndex = index;
  }
  return result.has('Recent user queries') ? result : undefined;
}

function parseMarkdownItems(
  body: string,
  itemTitle: string,
  fields: readonly string[],
): unknown[][] | undefined {
  if (body === '_None_') return [];
  const prefix = `### ${itemTitle}\n`;
  if (!body.startsWith(prefix)) return undefined;
  const records = body
    .split(`\n\n${prefix}`)
    .map((record, index) =>
      parseMarkdownRecord(index === 0 ? record.slice(prefix.length) : record, fields),
    );
  return records.every((record) => record !== undefined) ? (records as unknown[][]) : undefined;
}

const INVALID_MARKDOWN_SCALAR = Symbol('invalid-markdown-scalar');

function parseMarkdownRecord(body: string, fields: readonly string[]): unknown[] | undefined {
  const lines = body.split('\n');
  if (lines.length !== fields.length) return undefined;
  const values = lines.map((line, index) => {
    const prefix = `- ${fields[index] ?? ''}: `;
    return line.startsWith(prefix)
      ? parseMarkdownScalar(line.slice(prefix.length))
      : INVALID_MARKDOWN_SCALAR;
  });
  return values.includes(INVALID_MARKDOWN_SCALAR) ? undefined : values;
}

function parseMarkdownScalar(text: string): unknown | typeof INVALID_MARKDOWN_SCALAR {
  try {
    const value: unknown = JSON.parse(text);
    return value === null || typeof value !== 'object' ? value : INVALID_MARKDOWN_SCALAR;
  } catch {
    return INVALID_MARKDOWN_SCALAR;
  }
}

function parseSubagentMarkdown(body: string): Record<string, unknown> | undefined {
  const parts = splitSubagentMarkdown(body);
  if (!parts) return undefined;
  const metadata = parseMarkdownRecord(parts.metadata, SUBAGENT_MARKDOWN_FIELDS);
  const items = parseMarkdownItems(parts.tasks, 'Task', SUBAGENT_ITEM_MARKDOWN_FIELDS);
  if (!metadata || !items) return undefined;
  return {
    capturedAtMs: metadata[0],
    total: metadata[1],
    omitted: metadata[2],
    textFieldsAreUntrusted: metadata[3],
    detailsHint: metadata[4],
    counts: Object.fromEntries(
      SUBAGENT_STATUSES.map((status, index) => [status, metadata[index + 5]]),
    ),
    items: items.map(parseSubagentMarkdownItem),
  };
}

function splitSubagentMarkdown(
  body: string,
): { readonly metadata: string; readonly tasks: string } | undefined {
  const emptySuffix = '\n\n_None_';
  if (body.endsWith(emptySuffix)) {
    return { metadata: body.slice(0, -emptySuffix.length), tasks: '_None_' };
  }
  const taskBoundary = '\n\n### Task\n';
  const taskStart = body.indexOf(taskBoundary);
  return taskStart < 0
    ? undefined
    : {
        metadata: body.slice(0, taskStart),
        tasks: `### Task\n${body.slice(taskStart + taskBoundary.length)}`,
      };
}

function parseSubagentMarkdownItem([
  taskId,
  status,
  agentName,
  executionMode,
  updatedAtMs,
  delivered,
  description,
  lastError,
  finalResultPreview,
]: readonly unknown[]): Record<string, unknown> {
  return {
    taskId,
    status,
    ...(agentName === null ? {} : { agentName }),
    ...(executionMode === null ? {} : { executionMode }),
    updatedAtMs,
    delivered,
    ...(description === null ? {} : { description }),
    ...(lastError === null ? {} : { lastError }),
    ...(finalResultPreview === null ? {} : { finalResultPreview }),
  };
}

function parseAppendixV1(value: Record<string, unknown>): CompactionAppendixV1 | undefined {
  const common = parseAppendixCommon(value, APPENDIX_V1_KEYS);
  return common ? { version: 1, ...common } : undefined;
}

function parseAppendixV2(value: Record<string, unknown>): CompactionAppendixV2 | undefined {
  const common = parseAppendixCommon(value, APPENDIX_V2_KEYS);
  const cadence = normalizeOptionalTodoCadence(value);
  if (!common || !cadence.valid) return undefined;
  return {
    version: 2,
    ...common,
    ...(cadence.value === undefined ? {} : { todoCadence: cadence.value }),
  };
}

function parseAppendixV3(value: Record<string, unknown>): CompactionAppendixV3 | undefined {
  const common = parseAppendixCommon(value, APPENDIX_V3_KEYS);
  const cadence = normalizeOptionalTodoCadence(value);
  const subagents = normalizeOptionalSubagents(value);
  if (!common || !cadence.valid || !subagents.valid) return undefined;
  return {
    version: 3,
    ...common,
    ...(cadence.value === undefined ? {} : { todoCadence: cadence.value }),
    ...(subagents.value === undefined ? {} : { subagents: subagents.value }),
  };
}

function parseAppendixCommon(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): Omit<CompactionAppendixV1, 'version'> | undefined {
  if (Object.keys(value).some((key) => !allowed.has(key))) return undefined;
  const recentUserQueries = normalizeQueries(value['recentUserQueries']);
  const todo = normalizeOptionalTodo(value);
  if (!recentUserQueries || !todo.valid) return undefined;
  return {
    recentUserQueries,
    ...(todo.value === undefined ? {} : { todoState: todo.value }),
  };
}

function readLegacyV2(marker: Record<string, unknown>): CompactionCompatibility | undefined {
  if (marker['version'] !== 2 || typeof marker['summary'] !== 'string') return undefined;
  const recentUserQueries = normalizeQueries(marker['recentUserQueries']);
  const todo = normalizeOptionalTodo(marker);
  if (!recentUserQueries || !todo.valid) return undefined;
  return {
    summary: marker['summary'],
    recentUserQueries,
    ...(todo.value === undefined ? {} : { todoState: todo.value }),
  };
}

function normalizeOptionalSubagents(value: Record<string, unknown>): {
  readonly valid: boolean;
  readonly value?: CompactionSubagentState;
} {
  if (!Object.hasOwn(value, 'subagents')) return { valid: true };
  const subagents = value['subagents'];
  if (!isRecord(subagents) || !hasValidSubagentEnvelope(subagents)) return { valid: false };
  const counts = normalizeSubagentCounts(subagents['counts']);
  const items = normalizeSubagentItems(subagents['items']);
  const total = subagents['total'];
  const omitted = subagents['omitted'];
  if (!counts || !items) return { valid: false };
  const countsTotal = Object.values(counts).reduce((sum, count) => sum + count, 0);
  if (
    countsTotal !== total ||
    items.length + omitted !== total ||
    !subagentCountsCoverItems(counts, items)
  ) {
    return { valid: false };
  }
  return {
    valid: true,
    value: {
      capturedAtMs: subagents['capturedAtMs'],
      total,
      counts,
      omitted,
      textFieldsAreUntrusted: true,
      detailsHint: SUBAGENT_CHECKPOINT_DETAILS_HINT,
      items,
    },
  };
}

function subagentCountsCoverItems(
  counts: Readonly<Record<CompactionSubagentStatus, number>>,
  items: readonly CompactionSubagentItem[],
): boolean {
  const visibleCounts = Object.fromEntries(
    SUBAGENT_STATUSES.map((status) => [status, 0]),
  ) as Record<CompactionSubagentStatus, number>;
  items.forEach((item) => {
    visibleCounts[item.status] += 1;
  });
  return SUBAGENT_STATUSES.every((status) => visibleCounts[status] <= counts[status]);
}

function hasValidSubagentEnvelope(subagents: Record<string, unknown>): subagents is Record<
  string,
  unknown
> & {
  capturedAtMs: number;
  total: number;
  omitted: number;
  counts: Record<string, unknown>;
  items: unknown[];
} {
  return [
    Object.keys(subagents).every((key) => SUBAGENT_KEYS.has(key)),
    subagents['textFieldsAreUntrusted'] === true,
    subagents['detailsHint'] === SUBAGENT_CHECKPOINT_DETAILS_HINT,
    isNonNegativeSafeInteger(subagents['capturedAtMs']),
    isNonNegativeSafeInteger(subagents['total']),
    isNonNegativeSafeInteger(subagents['omitted']),
    isRecord(subagents['counts']),
    Array.isArray(subagents['items']),
    Array.isArray(subagents['items']) && subagents['items'].length <= 8,
    Buffer.byteLength(JSON.stringify(subagents), 'utf8') <= 4_096,
  ].every(Boolean);
}

function normalizeSubagentCounts(
  value: Record<string, unknown>,
): Record<CompactionSubagentStatus, number> | undefined {
  if (
    Object.keys(value).length !== SUBAGENT_STATUSES.length ||
    Object.keys(value).some(
      (key) =>
        !SUBAGENT_STATUSES.includes(key as CompactionSubagentStatus) ||
        !isNonNegativeSafeInteger(value[key]),
    )
  ) {
    return undefined;
  }
  return Object.fromEntries(SUBAGENT_STATUSES.map((status) => [status, value[status]])) as Record<
    CompactionSubagentStatus,
    number
  >;
}

function normalizeSubagentItems(value: readonly unknown[]): CompactionSubagentItem[] | undefined {
  const seen = new Set<string>();
  const items: CompactionSubagentItem[] = [];
  for (const valueItem of value) {
    const item = normalizeSubagentItem(valueItem);
    if (!item || seen.has(item.taskId)) return undefined;
    seen.add(item.taskId);
    items.push(item);
  }
  return items;
}

function normalizeSubagentItem(value: unknown): CompactionSubagentItem | undefined {
  if (!isSubagentItemRecord(value)) return undefined;
  const fields: ParsedSubagentItemFields = {
    taskId: nonEmpty(value['taskId']),
    status: readSubagentStatus(value['status']),
    updatedAtMs: value['updatedAtMs'],
    delivered: value['delivered'],
    agentName: optionalBoundedText(value, 'agentName', 120),
    description: optionalBoundedText(value, 'description', 120),
    lastError: optionalBoundedText(value, 'lastError', 120),
    finalResultPreview: optionalBoundedText(value, 'finalResultPreview', 200),
    executionMode: optionalExecutionMode(value['executionMode']),
  };
  if (!isValidSubagentItemFields(fields)) return undefined;
  return buildSubagentItem(fields);
}

interface ParsedSubagentItemFields {
  readonly taskId: string | undefined;
  readonly status: CompactionSubagentStatus | undefined;
  readonly updatedAtMs: unknown;
  readonly delivered: unknown;
  readonly agentName: string | undefined | null;
  readonly description: string | undefined | null;
  readonly lastError: string | undefined | null;
  readonly finalResultPreview: string | undefined | null;
  readonly executionMode: CompactionSubagentItem['executionMode'] | undefined | null;
}

interface ValidSubagentItemFields extends ParsedSubagentItemFields {
  readonly taskId: string;
  readonly status: CompactionSubagentStatus;
  readonly updatedAtMs: number;
  readonly delivered: boolean;
  readonly agentName: string | undefined;
  readonly description: string | undefined;
  readonly lastError: string | undefined;
  readonly finalResultPreview: string | undefined;
  readonly executionMode: CompactionSubagentItem['executionMode'] | undefined;
}

function isSubagentItemRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).every((key) => SUBAGENT_ITEM_KEYS.has(key));
}

function isValidSubagentItemFields(
  fields: ParsedSubagentItemFields,
): fields is ValidSubagentItemFields {
  return [
    fields.taskId !== undefined,
    fields.status !== undefined,
    isNonNegativeSafeInteger(fields.updatedAtMs),
    typeof fields.delivered === 'boolean',
    fields.agentName !== null,
    fields.description !== null,
    fields.lastError !== null,
    fields.finalResultPreview !== null,
    fields.executionMode !== null,
    fields.lastError === undefined || fields.status === 'failed',
    fields.finalResultPreview === undefined ||
      (fields.status !== undefined && TERMINAL_SUBAGENT_STATUSES.has(fields.status)),
  ].every(Boolean);
}

function buildSubagentItem(fields: ValidSubagentItemFields): CompactionSubagentItem {
  return {
    taskId: fields.taskId,
    status: fields.status,
    ...(fields.agentName === undefined ? {} : { agentName: fields.agentName }),
    ...(fields.executionMode === undefined ? {} : { executionMode: fields.executionMode }),
    updatedAtMs: fields.updatedAtMs,
    delivered: fields.delivered,
    ...(fields.description === undefined ? {} : { description: fields.description }),
    ...(fields.lastError === undefined ? {} : { lastError: fields.lastError }),
    ...(fields.finalResultPreview === undefined
      ? {}
      : { finalResultPreview: fields.finalResultPreview }),
  };
}

function optionalBoundedText(
  value: Record<string, unknown>,
  key: string,
  maxLength: number,
): string | undefined | null {
  if (!Object.hasOwn(value, key)) return undefined;
  const text = nonEmpty(value[key]);
  return text && text.length <= maxLength ? text : null;
}

function readSubagentStatus(value: unknown): CompactionSubagentStatus | undefined {
  return typeof value === 'string' && SUBAGENT_STATUSES.includes(value as CompactionSubagentStatus)
    ? (value as CompactionSubagentStatus)
    : undefined;
}

function optionalExecutionMode(
  value: unknown,
): CompactionSubagentItem['executionMode'] | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === 'string' && SUBAGENT_EXECUTION_MODES.has(value)
    ? (value as CompactionSubagentItem['executionMode'])
    : null;
}

function normalizeQueries(value: unknown): CompactionUserQuery[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const queries = value.flatMap((query) => {
    if (!isRecord(query) || typeof query['text'] !== 'string' || !query['text'].trim()) return [];
    const timestampMs = query['timestampMs'];
    if (timestampMs !== undefined && !isFiniteNumber(timestampMs)) return [];
    return [{ text: query['text'], ...(timestampMs === undefined ? {} : { timestampMs }) }];
  });
  return queries.length === value.length ? queries.slice(-2) : undefined;
}

function normalizeOptionalTodo(value: Record<string, unknown>): {
  readonly valid: boolean;
  readonly value?: readonly CompactionTodoItem[];
} {
  if (!Object.hasOwn(value, 'todoState')) return { valid: true };
  const todoState = normalizeTodoItems(value['todoState']);
  return todoState ? { valid: true, value: todoState } : { valid: false };
}

function normalizeOptionalTodoCadence(value: Record<string, unknown>): {
  readonly valid: boolean;
  readonly value?: CompactionTodoCadence;
} {
  if (!Object.hasOwn(value, 'todoCadence')) return { valid: true };
  const cadence = value['todoCadence'];
  if (!isRecord(cadence)) return { valid: false };
  const allowed = new Set([
    'assistantIterationsSinceTodoWrite',
    'assistantIterationsSinceReminder',
  ]);
  if (Object.keys(cadence).some((key) => !allowed.has(key))) return { valid: false };
  const assistantIterationsSinceTodoWrite = cadence['assistantIterationsSinceTodoWrite'];
  const assistantIterationsSinceReminder = cadence['assistantIterationsSinceReminder'];
  if (
    !isCadenceCount(assistantIterationsSinceTodoWrite) ||
    !isCadenceCount(assistantIterationsSinceReminder)
  ) {
    return { valid: false };
  }
  return {
    valid: true,
    value: { assistantIterationsSinceTodoWrite, assistantIterationsSinceReminder },
  };
}

function normalizeOptionalBackgroundCadence(value: Record<string, unknown>): {
  readonly valid: boolean;
  readonly value?: CompactionBackgroundCadence;
} {
  if (!Object.hasOwn(value, 'backgroundCadence')) return { valid: true };
  const cadence = value['backgroundCadence'];
  if (!isRecord(cadence)) return { valid: false };
  if (
    Object.keys(cadence).some(
      (key) => key !== 'assistantIterationsSinceReminder' && key !== 'observedTerminalCount',
    )
  ) {
    return { valid: false };
  }
  const assistantIterationsSinceReminder = cadence['assistantIterationsSinceReminder'];
  const observedTerminalCount = cadence['observedTerminalCount'];
  if (
    !isCadenceCount(assistantIterationsSinceReminder) ||
    (observedTerminalCount !== undefined && !isNonNegativeSafeInteger(observedTerminalCount))
  ) {
    return { valid: false };
  }
  return {
    valid: true,
    value: {
      assistantIterationsSinceReminder,
      ...(observedTerminalCount === undefined ? {} : { observedTerminalCount }),
    },
  };
}

function isCadenceCount(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= TODO_CADENCE_INTERVAL
  );
}

export function normalizeTodoItems(value: unknown): CompactionTodoItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const content = nonEmpty(item['content']);
    const status = nonEmpty(item['status']);
    const priority = nonEmpty(item['priority']);
    return content && status && priority ? [{ content, status, priority }] : [];
  });
  return items.length === value.length ? items : undefined;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
