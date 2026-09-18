import { describe, expect, it, vi } from 'vitest';

import { TuiRunCoordinator } from '../../src/application/run-coordinator.js';
import type { TuiMessage } from '../../src/runtime/stream-events.js';

describe('TuiRunCoordinator response usage', () => {
  it('counts each response once, accepts corrections, and preserves buckets absent from later responses', async () => {
    const first: TuiMessage = { id: 'response-1', turnId: 'turn-1', role: 'assistant', content: 'work', usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 50 } };
    const messages: TuiMessage[] = [
      first,
      first,
      { ...first, usage: { inputTokens: 6, outputTokens: undefined } },
      { ...first, id: 'response-2', usage: { outputTokens: 3 } },
      { ...first, id: 'other-turn', turnId: 'other', usage: { inputTokens: 100 } },
      { ...first, id: 'compaction', kind: 'compaction', usage: undefined },
    ];
    const runtime = {
      sendMessage: vi.fn(async function* () {
        for (const message of messages) yield { type: 'message' as const, message };
        yield { type: 'session-status' as const, status: 'finished' as const };
      }),
      abortSession: vi.fn(async () => true),
      steer: vi.fn(async () => ({ queueItemId: 'unused' })),
    };
    const result = await new TuiRunCoordinator(runtime).execute({
      turnId: 'turn-1', session: Promise.resolve({ sessionId: 'session-1' }),
      content: 'Fix it', workspace: '/tmp/workspace', version: 'test',
    });

    expect(result.outcome.usage).toEqual({ inputTokens: 6, outputTokens: 5, cacheReadTokens: 50 });
    expect(result.outcome.usageResponses).toHaveLength(2);
    expect(result.outcome.usageResponses?.map((response) => response.messageId)).toEqual(['response-1', 'response-2']);
  });
});
