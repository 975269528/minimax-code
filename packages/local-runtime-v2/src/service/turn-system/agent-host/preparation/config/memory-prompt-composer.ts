import {
  DAILY_RECENT_CAP_CHARS,
  MEMORY_SUMMARY_INJECTION_CAP_CHARS,
  MEMORY_TAIL_INJECTION_CAP_CHARS,
} from '@mavis/shared';

import {
  buildAvailableMemoryTopicsBlock,
  buildDailyMemoryBlock,
  buildMemoryNoteBlock,
  buildMemorySummaryBlock,
  buildMemoryTailBlock,
  buildUserProfileBlock,
  type MemoryPromptBlockOptions,
  type MemoryPromptSource,
} from '../prompt-blocks.js';

export interface LocalPromptMemoryReader {
  /** Shared user.md is not Agent-local and remains available to Custom Agents. */
  getUserMemory?(): Promise<{ readonly content: string }>;
  collectReminderMemory(agentName: string): Promise<{
    readonly main: string;
    readonly mainPath: string;
    readonly user: string;
    readonly userPath: string;
    readonly summary: string;
    readonly topics: readonly {
      readonly name: string;
      readonly description: string;
      readonly path: string;
    }[];
  }>;
  getDaily(agentName: string, date: string): Promise<{ readonly content: string }>;
}

type ReminderMemory = Awaited<ReturnType<LocalPromptMemoryReader['collectReminderMemory']>>;

export function toMemoryPromptSources(agentNames: readonly string[]): MemoryPromptSource[] {
  return agentNames
    .map((name) => name.trim())
    .filter((name, index, all) => name.length > 0 && all.indexOf(name) === index)
    .map((agentName, index) => ({
      agentName,
      canonical: index === 0,
    }));
}

export async function collectMemoryBlocks(
  reader: LocalPromptMemoryReader,
  sources: readonly MemoryPromptSource[],
  nowMs: () => number,
  options: {
    readonly includeAgentMemory: boolean;
    readonly prompt?: MemoryPromptBlockOptions;
  },
): Promise<readonly string[]> {
  const blocks: string[] = [];
  if (!options.includeAgentMemory) {
    await appendIndependentUserMemoryBlock({
      blocks,
      reader,
      sources,
      prompt: options.prompt,
    });
    return blocks;
  }

  const snapshots: Array<{ source: MemoryPromptSource; memory: ReminderMemory }> = [];
  for (const source of sources) {
    try {
      snapshots.push({
        source,
        memory: await reader.collectReminderMemory(source.agentName),
      });
    } catch {
      // One broken compatibility directory must not hide the rest of the family.
    }
  }

  appendUserMemorySnapshot(blocks, snapshots, options.prompt);
  appendCanonicalMemorySnapshots(blocks, snapshots, options.prompt);
  appendLegacyMemorySnapshots(blocks, snapshots, options.prompt);
  await appendDailyMemoryBlock(blocks, reader, sources, nowMs);
  return blocks;
}

function appendUserMemorySnapshot(
  blocks: string[],
  snapshots: readonly { source: MemoryPromptSource; memory: ReminderMemory }[],
  options?: MemoryPromptBlockOptions,
): void {
  const userSnapshot = snapshots.find(({ memory }) => memory.user.trim());
  if (!userSnapshot) return;
  const userBlock = buildUserMemoryBlock(userSnapshot.memory.user, options);
  if (!userBlock) return;
  blocks.push(userBlock);
}

async function appendIndependentUserMemoryBlock(input: {
  readonly blocks: string[];
  readonly reader: LocalPromptMemoryReader;
  readonly sources: readonly MemoryPromptSource[];
  readonly prompt?: MemoryPromptBlockOptions;
}): Promise<void> {
  const user = await readUserMemory(input.reader, input.sources);
  if (!user?.content.trim()) return;
  const userBlock = buildUserMemoryBlock(user.content, input.prompt);
  if (!userBlock) return;
  input.blocks.push(userBlock);
}

async function readUserMemory(
  reader: LocalPromptMemoryReader,
  sources: readonly MemoryPromptSource[],
): Promise<{ readonly content: string; readonly path?: string } | undefined> {
  try {
    if (reader.getUserMemory) return await reader.getUserMemory();
    const source = sources[0];
    if (!source) return undefined;
    const memory = await reader.collectReminderMemory(source.agentName);
    return { content: memory.user, path: memory.userPath };
  } catch {
    return undefined;
  }
}

function appendCanonicalMemorySnapshots(
  blocks: string[],
  snapshots: readonly { source: MemoryPromptSource; memory: ReminderMemory }[],
  options?: MemoryPromptBlockOptions,
): void {
  for (const snapshot of snapshots.filter(({ source }) => source.canonical)) {
    blocks.push(...buildCanonicalMemoryBlocks(snapshot.memory, options));
  }
}

function appendLegacyMemorySnapshots(
  blocks: string[],
  snapshots: readonly { source: MemoryPromptSource; memory: ReminderMemory }[],
  options?: MemoryPromptBlockOptions,
): void {
  // All retired owners share one additional tail-sized budget.
  let legacyBudget = MEMORY_TAIL_INJECTION_CAP_CHARS;
  for (const snapshot of snapshots.filter(({ source }) => !source.canonical)) {
    legacyBudget = appendLegacyMemoryBlocks(blocks, snapshot, legacyBudget, options);
    if (legacyBudget <= 0) break;
  }
}

async function appendDailyMemoryBlock(
  blocks: string[],
  reader: LocalPromptMemoryReader,
  sources: readonly MemoryPromptSource[],
  nowMs: () => number,
): Promise<void> {
  const canonicalAgentName = sources.find((source) => source.canonical)?.agentName;
  if (!canonicalAgentName) return;
  const daily = await collectDailyMemory(reader, canonicalAgentName, nowMs);
  if (daily) blocks.push(buildDailyMemoryBlock(daily));
}

function buildUserMemoryBlock(
  rawUser: string,
  options?: MemoryPromptBlockOptions,
): string | undefined {
  const user = rawUser.trim();
  if (!user) return undefined;
  const capped = user.length > MEMORY_TAIL_INJECTION_CAP_CHARS;
  const capNote = capped
    ? `\n> Content truncated — ${user.length.toLocaleString()} chars, showing latest ${MEMORY_TAIL_INJECTION_CAP_CHARS.toLocaleString()} chars.`
    : '';
  const content = capped ? user.slice(-MEMORY_TAIL_INJECTION_CAP_CHARS) : user;
  return buildUserProfileBlock(content, capNote, options);
}

function buildCanonicalMemoryBlocks(
  memory: ReminderMemory,
  options?: MemoryPromptBlockOptions,
): string[] {
  const main = memory.main.trim();
  const blocks: string[] = [];
  if (main) {
    const summary = memory.summary.trim();
    const capped = main.length > MEMORY_TAIL_INJECTION_CAP_CHARS;
    if (capped && summary) {
      blocks.push(
        buildMemorySummaryBlock(
          summary.slice(0, MEMORY_SUMMARY_INJECTION_CAP_CHARS),
          memory.mainPath,
          options,
        ),
      );
    }
    blocks.push(
      buildMemoryTailBlock(
        capped ? main.slice(-MEMORY_TAIL_INJECTION_CAP_CHARS) : main,
        memory.mainPath,
        options,
      ),
    );
    if (capped && !summary) blocks.push(buildMemoryNoteBlock(memory.mainPath));
  }
  if (memory.topics.length > 0) {
    blocks.push(buildAvailableMemoryTopicsBlock(memory.topics, options));
  }
  return blocks;
}

function appendLegacyMemoryBlocks(
  blocks: string[],
  snapshot: { readonly source: MemoryPromptSource; readonly memory: ReminderMemory },
  budget: number,
  options?: MemoryPromptBlockOptions,
): number {
  let remaining = budget;
  if (remaining <= 0) return 0;
  const legacyOptions: MemoryPromptBlockOptions = {
    ...options,
    includeWriteGuidance: false,
    sourceAgent: snapshot.source.agentName,
    legacy: true,
  };
  remaining = appendLegacyMain(blocks, snapshot, remaining, legacyOptions);
  remaining = appendLegacySummary(blocks, snapshot, remaining, legacyOptions);
  return appendLegacyTopics(blocks, snapshot.memory.topics, remaining, legacyOptions);
}

function appendLegacyMain(
  blocks: string[],
  snapshot: { readonly memory: ReminderMemory },
  budget: number,
  options: MemoryPromptBlockOptions,
): number {
  const main = snapshot.memory.main.trim();
  if (!main || budget <= 0) return budget;
  const shown = main.length > budget ? main.slice(-budget) : main;
  blocks.push(buildMemoryTailBlock(shown, snapshot.memory.mainPath, options));
  return budget - shown.length;
}

function appendLegacySummary(
  blocks: string[],
  snapshot: { readonly memory: ReminderMemory },
  budget: number,
  options: MemoryPromptBlockOptions,
): number {
  const summary = snapshot.memory.summary.trim();
  if (!summary || budget <= 0) return budget;
  const shown = summary.slice(0, Math.min(MEMORY_SUMMARY_INJECTION_CAP_CHARS, budget));
  if (!shown) return budget;
  blocks.push(buildMemorySummaryBlock(shown, snapshot.memory.mainPath, options));
  return budget - shown.length;
}

function appendLegacyTopics(
  blocks: string[],
  topics: ReminderMemory['topics'],
  budget: number,
  options: MemoryPromptBlockOptions,
): number {
  if (budget <= 0 || topics.length === 0) return budget;
  let remainingTopics = topics;
  while (remainingTopics.length > 0) {
    const candidate = buildAvailableMemoryTopicsBlock(remainingTopics, options);
    if (candidate.length <= budget) {
      blocks.push(candidate);
      return budget - candidate.length;
    }
    remainingTopics = remainingTopics.slice(0, -1);
  }
  return budget;
}

async function collectDailyMemory(
  reader: LocalPromptMemoryReader,
  agentName: string,
  nowMs: () => number,
): Promise<string | undefined> {
  try {
    return await readDailyDigest(reader, agentName, nowMs);
  } catch {
    return undefined;
  }
}

async function readDailyDigest(
  reader: LocalPromptMemoryReader,
  agentName: string,
  nowMs: () => number,
): Promise<string | undefined> {
  const now = new Date(nowMs());
  const sections: string[] = [];
  for (let offset = 0; offset <= 7; offset += 1) {
    const date = new Date(now);
    date.setDate(date.getDate() - offset);
    const key = formatLocalDate(date);
    const content = stripTerminalActivityLines((await reader.getDaily(agentName, key)).content);
    if (!content) continue;
    if (offset <= 1) {
      sections.push(
        `## ${key}\n${
          content.length > DAILY_RECENT_CAP_CHARS
            ? `... (truncated)\n${content.slice(-DAILY_RECENT_CAP_CHARS)}`
            : content
        }`,
      );
    } else {
      const flat = content.slice(0, 500).replace(/\n/gu, ' ').trim();
      sections.push(`## ${key} (summary)\n${flat}${content.length > 500 ? '...' : ''}`);
    }
  }
  return sections.length > 0 ? sections.slice(0, 8).join('\n\n') : undefined;
}

const TERMINAL_ACTIVITY_LINE_RE =
  /^- (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) session=\S+ turn=\S+ status=(?:finished|error|aborted|interrupted)$/u;

function stripTerminalActivityLines(content: string): string {
  return content
    .split(/\r?\n/u)
    .filter((line) => !isTerminalActivityLine(line))
    .join('\n')
    .trim();
}

function isTerminalActivityLine(line: string): boolean {
  const match = TERMINAL_ACTIVITY_LINE_RE.exec(line);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  return isValidActivityTimestamp({ year, month, day, hour, minute, second });
}

function isValidActivityTimestamp(input: {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}): boolean {
  const { year, month, day, hour, minute, second } = input;
  if (!isValidActivityClock(month, hour, minute, second)) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const maxDay = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  return day >= 1 && day <= maxDay;
}

function isValidActivityClock(
  month: number,
  hour: number,
  minute: number,
  second: number,
): boolean {
  return month >= 1 && month <= 12 && hour <= 23 && minute <= 59 && second <= 59;
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
