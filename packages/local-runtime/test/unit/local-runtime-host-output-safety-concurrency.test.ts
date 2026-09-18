// Concurrency isolation for the output-safety host loop.
//
// The blocked flag / abort / review buffers live on per-attempt writer instances
// (locals inside runTurn), never on the shared host. This test runs two turns
// concurrently through ONE host — one whose output is rejected, one clean — and
// asserts the rejection cannot leak into the clean turn.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LocalRuntimeHost, type LocalTurnRunner } from '../../src/runtime/host.js';
import { RespDataType } from '@mavis/agent-core/protocol/agent-message';
import { RuntimeEventType, type IRuntimeEvent } from '@mavis/protocol';

function finalMessage(content: string): IRuntimeEvent {
  return {
    schema: 'runtime.event/v1',
    event_id: `evt_${Math.random().toString(36).slice(2)}`,
    session_id: 'ses',
    turn_id: 'turn',
    type: RuntimeEventType.STREAM_RESP,
    payload: {
      stream_resp: JSON.stringify({
        type: RespDataType.AgentMessage,
        agent_message: { msg_id: `msg_${Math.random().toString(36).slice(2)}`, msg_content: content },
      }),
    },
  } as IRuntimeEvent;
}

/** Reject any review whose content contains the marker 'BLOCK', else pass. */
function installContentAwareFetch() {
  const reviewedTurns = new Set<boolean>();
  let releaseFirstReviews!: () => void;
  const firstReviews = new Promise<void>((resolve) => {
    releaseFirstReviews = resolve;
  });
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { content_text: string };
    const blocked = body.content_text.includes('BLOCK');
    // Hold both initial reviews until both turns have reached the shared gateway.
    reviewedTurns.add(blocked);
    if (reviewedTurns.size === 2) releaseFirstReviews();
    await firstReviews;
    return Response.json(
      blocked
        ? { action: 4, errorCode: 50201 }
        : { action: 1 },
    );
  });
}

describe('LocalRuntimeHost output safety — concurrency isolation', () => {
  beforeEach(() => {
    delete process.env.IDC;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.IDC;
  });

  it('a rejected turn never contaminates a concurrent clean turn', async () => {
    const fetchMock = installContentAwareFetch();
    // One shared runner + one shared host drive both turns. Each turn emits
    // content keyed off its own sessionId.
    const runner: LocalTurnRunner = {
      async runTurn(input) {
        const content =
          input.sessionId === 'ses_block' ? 'BLOCK this unsafe output' : 'a perfectly safe answer';
        await input.eventWriter.pushRuntime(finalMessage(content));
      },
    };
    const host = new LocalRuntimeHost({ safetyApiVersion: 'v2', piRunner: runner });

    const blockRecall = vi.fn();
    const okRecall = vi.fn();
    const base = {
      workspaceDir: '/tmp/ws',
      systemPrompt: '',
      userMessage: { text: 'hi' },
      llm: { model: {} as never },
      rewindPiHistory: async () => {},
    };

    const [blockOut, okOut] = await Promise.all([
      host.runTurn({
        ...base,
        sessionId: 'ses_block',
        turnId: 't_block',
        onOutputRecall: blockRecall,
      }),
      host.runTurn({ ...base, sessionId: 'ses_ok', turnId: 't_ok', onOutputRecall: okRecall }),
    ]);

    // The rejected turn retracts; the clean turn is entirely unaffected.
    expect(blockOut.retracted).toBe(true);
    expect(okOut.retracted).toBe(false);

    // Clean turn forwarded its content; blocked turn forwarded no assistant text.
    const okText = okOut.events
      .filter((e) => e.type === RuntimeEventType.STREAM_RESP)
      .map((e) => String(e.payload?.stream_resp ?? ''))
      .join('');
    expect(okText).toContain('perfectly safe answer');
    expect(okText).not.toContain('BLOCK');
    expect(
      blockOut.events.filter((e) => e.type === RuntimeEventType.STREAM_RESP),
    ).toHaveLength(0);

    // Recall fired only for the blocked turn's regenerations.
    expect(okRecall).not.toHaveBeenCalled();
    expect(blockRecall).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    const requests = fetchMock.mock.calls.map(([url, init]) => {
      expect(String(url)).toContain('/mavis/api/v2/content?require_auth=true');
      return JSON.parse(String(init?.body)) as { content_text: string; scene: number };
    });
    expect(requests.filter((body) => body.content_text.includes('BLOCK'))).toHaveLength(4);
    expect(requests.filter((body) => !body.content_text.includes('BLOCK'))).toHaveLength(1);
    expect(requests.every((body) => body.scene === 11)).toBe(true);
  });
});
