/**
 * Evolution reminder logic — memory write prompts.
 *
 * v3: skill crystallization in-turn reminder removed. Skill reflection moved
 * to the daily-digest session-end fallback re-prompt (see
 * `daily-digest.ts:runSessionLevelFallback`) and the 05:00 memory-cleanup
 * spawn (multi-session pattern detection). The state map signatures still
 * carry `lastSkillReminderAt` / `nextSkillReminderAt` / `skillReminderGap`
 * so external callers compile during the rename window — they're unused
 * by this function in v3.
 *
 * Migrated from legacy prompt transform.
 * State (counters, snapshots) lives on SystemReminderService instance fields.
 */

import type { MemoryDirSnapshot } from './types.js';
import { EVOLUTION_CONFIG } from './types.js';

// ─── Bound helpers ───────────────────────────────────────────────────────────

const MAX_MAP_SIZE = 200;

/** Evict oldest entries when a Map exceeds the size bound. */
export function boundMap<K, V>(map: Map<K, V>, max = MAX_MAP_SIZE): void {
  if (map.size <= max) return;
  const keysToDelete = [...map.keys()].slice(0, map.size - max);
  for (const key of keysToDelete) {
    map.delete(key);
  }
}

// ─── Evolution Reminder ──────────────────────────────────────────────────────

export interface EvolutionState {
  memorySnapshots: Map<string, MemoryDirSnapshot>;
  /** @deprecated v3: skill in-turn reminder removed. Field kept so existing
   * SystemReminderService field declarations compile; not read by
   * `getEvolutionReminder` anymore. */
  lastSkillReminderAt: Map<string, number>;
  /** Next turn at which to fire memory reminder (exponential back-off). */
  nextMemoryReminderAt: Map<string, number>;
  /** Current back-off gap for memory reminder (doubles on each miss). */
  memoryReminderGap: Map<string, number>;
  /** @deprecated v3: skill in-turn reminder removed. */
  nextSkillReminderAt: Map<string, number>;
  /** @deprecated v3: skill in-turn reminder removed. */
  skillReminderGap: Map<string, number>;
}

/**
 * Check evolution conditions and return reminder text if needed.
 *
 * v3: only the memory write reminder remains. Schedule:
 *   - First fires at turn INITIAL_INTERVAL (10)
 *   - If ignored, gap doubles: 10 → 20 → 40 (capped at MAX)
 *   - Preserves backoff pace when agent writes memory (only snapshot updated)
 *
 * Skill crystallization reminder removed — skill reflection now happens at
 * session end via the daily-digest fallback re-prompt and at 05:00 via the
 * memory-cleanup multi-session pattern scan.
 *
 * @param currentMemorySnapshot - Host-collected snapshot of agent-level memory files
 * @param sessionId - Current session ID
 * @param agentName - Agent name (for mavis memory commands)
 * @param turnCount - Current turn number (1-indexed, from service layer)
 * @param state - Mutable state maps (owned by SystemReminderService)
 * @returns Reminder text or undefined
 */
export function getEvolutionReminder(
  currentMemorySnapshot: MemoryDirSnapshot | undefined,
  sessionId: string,
  _agentName: string,
  turnCount: number,
  state: EvolutionState,
): string | undefined {
  if (!currentMemorySnapshot) return undefined;

  // Take initial snapshot on first call (agent memory dir — session memory removed)
  if (!state.memorySnapshots.has(sessionId)) {
    state.memorySnapshots.set(sessionId, cloneMemorySnapshot(currentMemorySnapshot));
    boundMap(state.memorySnapshots);
  }

  const reminders: string[] = [];

  // ── Memory reminder with exponential back-off ──
  const nextAt =
    state.nextMemoryReminderAt.get(sessionId) ?? EVOLUTION_CONFIG.MEMORY_REMINDER_INITIAL_INTERVAL;
  const currentGap =
    state.memoryReminderGap.get(sessionId) ?? EVOLUTION_CONFIG.MEMORY_REMINDER_INITIAL_INTERVAL;

  // Compaction detection: if turnCount dropped below the last fire point
  // (context was compressed), reset the back-off schedule.
  const lastFiredAt = nextAt - currentGap;
  if (lastFiredAt > 0 && turnCount < lastFiredAt) {
    state.nextMemoryReminderAt.set(
      sessionId,
      turnCount + EVOLUTION_CONFIG.MEMORY_REMINDER_INITIAL_INTERVAL,
    );
    state.memoryReminderGap.set(sessionId, EVOLUTION_CONFIG.MEMORY_REMINDER_INITIAL_INTERVAL);
  }

  const effectiveNextAt =
    state.nextMemoryReminderAt.get(sessionId) ?? EVOLUTION_CONFIG.MEMORY_REMINDER_INITIAL_INTERVAL;

  if (turnCount >= effectiveNextAt) {
    const initial = state.memorySnapshots.get(sessionId)!; // eslint-disable-line @typescript-eslint/no-non-null-assertion
    const current = currentMemorySnapshot;
    const memoryChanged =
      current.maxMtime > initial.maxMtime || current.files.length > initial.files.length;
    const activeGap =
      state.memoryReminderGap.get(sessionId) ?? EVOLUTION_CONFIG.MEMORY_REMINDER_INITIAL_INTERVAL;

    if (!memoryChanged) {
      // Double the gap, capped at MAX
      const nextGap = Math.min(activeGap * 2, EVOLUTION_CONFIG.MEMORY_REMINDER_MAX_INTERVAL);
      state.memoryReminderGap.set(sessionId, nextGap);
      state.nextMemoryReminderAt.set(sessionId, turnCount + nextGap);
      boundMap(state.memoryReminderGap);
      boundMap(state.nextMemoryReminderAt);

      reminders.push(
        [
          `已工作 ${turnCount} 轮，检查一下有没有值得记住的东西。`,
          '',
          '问自己：这次 session 有没有学到**不看 memory 下次会重蹈覆辙**的教训？',
          '',
          '写入前用三问法判断归属（写到第一个匹配的层，不要默认 agent memory）：',
          '  1. 换用户会变？ → **User memory** (例: MR 合入偏好、沟通风格、序号指代习惯)',
          '  2. 换项目结论仍成立？ → **Agent memory** (例: CI 调试技巧、非交互 shell 用 .zshenv)',
          '  3. 只在当前项目成立？ → **Project memory** AGENTS.md / topic file (例: MR target dev、飞书群 chat_id)',
          '',
          '没有新东西？不写也完全没问题，不是每次都有新知识。',
          '',
          '不要写：代码结构、git 历史、API schema、已有文档能查到的信息。',
          '如果你还没读过 `mavis-memory` skill，先 load 它再写——里面有完整的分层规则和排除项。',
        ].join('\n'),
      );
    } else {
      // Memory was written — update baseline snapshot and advance schedule
      // by current gap (no reset to initial — backoff pace is preserved).
      state.memorySnapshots.set(sessionId, cloneMemorySnapshot(current));
      state.nextMemoryReminderAt.set(sessionId, turnCount + activeGap);
      boundMap(state.memorySnapshots);
      boundMap(state.nextMemoryReminderAt);
    }
  }

  return reminders.length > 0 ? reminders.join('\n\n---\n\n') : undefined;
}

function cloneMemorySnapshot(snapshot: MemoryDirSnapshot): MemoryDirSnapshot {
  return { files: [...snapshot.files], maxMtime: snapshot.maxMtime };
}
