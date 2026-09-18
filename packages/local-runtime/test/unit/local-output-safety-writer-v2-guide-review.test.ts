/**
 * LocalOutputSafetyEventWriter × SafetyCheckV2 guide review path.
 *
 * Coverage:
 * - Explicit V2 Review preserves a model-only guide and blocks the draft.
 * - V1 ignores guide fields and retains its original SR regeneration path.
 * - Guidance may appear only at the system_prompt boundary, never in final AgentMessage or
 *   user-visible stream events (hard boundary).
 * - consumeGuidePrompt / resetGuideReview state machine.
 * - Metrics counting (`output_safety_check_total{decision=guide_review}`).
 */
import { describe, it, expect, vi } from 'vitest';

import { RespDataType } from '@mavis/agent-core/protocol/agent-message';
import { RuntimeEventType, type IRuntimeEvent } from '@mavis/protocol';

import { LocalOutputSafetyEventWriter } from '../../src/runtime/output-safety-writer.js';
import {
  createLocalRuntimeMetricsClient,
  type LocalRuntimeMetricsClient,
} from '../../src/common/metrics.js';
import {
  callSafetyApi,
  SAFETY_SCENE,
  type SafetyCheckResult,
} from '../../src/content-safety/api.js';
import { LocalRuntimeHost, type LocalTurnRunner } from '../../src/runtime/host.js';
import { OUTPUT_REVISION_INSTRUCTION } from '../../src/runtime/output-safety-policy.js';

function contentChunk(text: string, msgId = 'msg_1'): IRuntimeEvent {
  return {
    schema: 'runtime.event/v1',
    event_id: `evt_${Math.random().toString(36).slice(2)}`,
    session_id: 'ses_1',
    turn_id: 'turn_1',
    type: RuntimeEventType.STREAM_RESP,
    payload: {
      stream_resp: JSON.stringify({
        type: RespDataType.AgentMessageChunk,
        agent_message_chunk: { msg_id: msgId, msg_content: text },
      }),
    },
  } as IRuntimeEvent;
}

function finalMessageEvent(content: string, msgId = 'msg_1'): IRuntimeEvent {
  return {
    schema: 'runtime.event/v1',
    event_id: `evt_${Math.random().toString(36).slice(2)}`,
    session_id: 'ses_1',
    turn_id: 'turn_1',
    type: RuntimeEventType.STREAM_RESP,
    payload: {
      stream_resp: JSON.stringify({
        type: RespDataType.AgentMessage,
        agent_message: { msg_id: msgId, msg_content: content },
      }),
    },
  } as IRuntimeEvent;
}

interface CapturedSinkEvent {
  type: RuntimeEventType;
  text: string;
}

function makeSink(): {
  inner: {
    pushRuntime: (e: IRuntimeEvent) => Promise<void>;
    appendEvents: (e: IRuntimeEvent[]) => Promise<void>;
  };
  captured: CapturedSinkEvent[];
} {
  const captured: CapturedSinkEvent[] = [];
  const inner = {
    async pushRuntime(event: IRuntimeEvent): Promise<void> {
      const raw = event.payload?.stream_resp;
      if (typeof raw === 'string') {
        try {
          const parsed = JSON.parse(raw) as {
            type: number;
            agent_message?: { msg_content?: string };
          };
          if (parsed.type === RespDataType.AgentMessage && parsed.agent_message) {
            captured.push({ type: event.type, text: parsed.agent_message.msg_content ?? '' });
          }
        } catch {
          // ignore parse error
        }
      }
    },
    async appendEvents(events: IRuntimeEvent[]): Promise<void> {
      for (const e of events) await inner.pushRuntime(e);
    },
  };
  return { inner, captured };
}

const SENTINEL_GUIDE_PROMPT = 'V2-SECRET-GUIDE-PROMPT-DO-NOT-LEAK';

describe('LocalOutputSafetyEventWriter — V2 guide review', () => {
  it('explicit Review with guide_prompt blocks the draft and preserves the next attempt guide', async () => {
    const checkText = vi.fn(
      async (): Promise<SafetyCheckResult> => ({
        pass: false,
        action: 'guide',
        guide_prompt: SENTINEL_GUIDE_PROMPT,
        errorKind: 'rejected',
      }),
    );
    const { inner } = makeSink();
    const sinkSpy = vi.spyOn(inner, 'pushRuntime');
    const onBlocked = vi.fn();
    const writer = new LocalOutputSafetyEventWriter(inner, {
      checkText,
      chunkThreshold: 0,
      onBlocked,
    });
    await writer.pushRuntime(contentChunk('rejected draft'));
    await writer.pushRuntime(finalMessageEvent('rejected final'));
    expect(writer.blocked).toBe(true);
    expect(writer.guideReviewed).toBe(true);
    expect(onBlocked).toHaveBeenCalledOnce();
    expect(sinkSpy).not.toHaveBeenCalled();
    expect(checkText).toHaveBeenCalledOnce();
    expect(writer.consumeGuidePrompt()).toBe(SENTINEL_GUIDE_PROMPT);
  });

  it('reject without guide_prompt → 走原 block 路径', async () => {
    const checkText = vi.fn(
      async (): Promise<SafetyCheckResult> => ({
        pass: false,
        reason: 'rejected',
        errorKind: 'rejected',
      }),
    );
    const { inner } = makeSink();
    const writer = new LocalOutputSafetyEventWriter(inner, {
      checkText,
      chunkThreshold: 0,
    });
    await writer.pushRuntime(contentChunk('内容'));
    expect(writer.blocked).toBe(true);
    expect(writer.guideReviewed).toBe(false);
    expect(writer.consumeGuidePrompt()).toBeUndefined();
  });

  it('reject + 空字符串 guide_prompt → 当作缺失,走 block 路径(防御性)', async () => {
    const checkText = vi.fn(
      async (): Promise<SafetyCheckResult> => ({
        pass: false,
        action: 'guide',
        reason: 'rejected',
        guide_prompt: '',
        errorKind: 'rejected',
      }),
    );
    const { inner } = makeSink();
    const writer = new LocalOutputSafetyEventWriter(inner, {
      checkText,
      chunkThreshold: 0,
    });
    await writer.pushRuntime(contentChunk('内容'));
    expect(writer.blocked).toBe(true);
    expect(writer.guideReviewed).toBe(false);
  });

  it('clean pass + 有 guide_prompt → 不动 guide state(guide_prompt 只在 reject 时有效)', async () => {
    const checkText = vi.fn(
      async (): Promise<SafetyCheckResult> => ({
        pass: true,
        guide_prompt: SENTINEL_GUIDE_PROMPT,
      }),
    );
    const { inner } = makeSink();
    const writer = new LocalOutputSafetyEventWriter(inner, {
      checkText,
      chunkThreshold: 0,
    });
    await writer.pushRuntime(contentChunk('OK'));
    expect(writer.blocked).toBe(false);
    expect(writer.guideReviewed).toBe(false);
    expect(writer.consumeGuidePrompt()).toBeUndefined();
  });

  it('consumeGuidePrompt() 调用后清空状态(避免跨 attempt 残留)', async () => {
    const checkText = vi.fn(
      async (): Promise<SafetyCheckResult> => ({
        pass: false,
        action: 'guide',
        reason: 'rejected',
        guide_prompt: SENTINEL_GUIDE_PROMPT,
        errorKind: 'rejected',
      }),
    );
    const { inner } = makeSink();
    const writer = new LocalOutputSafetyEventWriter(inner, {
      checkText,
      chunkThreshold: 0,
    });
    await writer.pushRuntime(contentChunk('问题内容'));
    expect(writer.guideReviewed).toBe(true);
    expect(writer.consumeGuidePrompt()).toBe(SENTINEL_GUIDE_PROMPT);
    expect(writer.consumeGuidePrompt()).toBeUndefined();
    expect(writer.guideReviewed).toBe(false);
  });

  it('resetGuideReview() 清空状态(host 每个 attempt 边界调一次)', async () => {
    const checkText = vi.fn(
      async (): Promise<SafetyCheckResult> => ({
        pass: false,
        action: 'guide',
        reason: 'rejected',
        guide_prompt: SENTINEL_GUIDE_PROMPT,
        errorKind: 'rejected',
      }),
    );
    const { inner } = makeSink();
    const writer = new LocalOutputSafetyEventWriter(inner, {
      checkText,
      chunkThreshold: 0,
    });
    await writer.pushRuntime(contentChunk('问题内容'));
    expect(writer.guideReviewed).toBe(true);
    writer.resetGuideReview();
    expect(writer.guideReviewed).toBe(false);
    expect(writer.consumeGuidePrompt()).toBeUndefined();
  });

  it('CRITICAL: V2 guide_prompt 绝不出现在 final AgentMessage / user-visible 流事件里', async () => {
    const checkText = vi.fn(
      async (): Promise<SafetyCheckResult> => ({
        pass: false,
        action: 'guide',
        reason: 'rejected',
        guide_prompt: SENTINEL_GUIDE_PROMPT,
        errorKind: 'rejected',
      }),
    );
    const { inner, captured } = makeSink();
    const writer = new LocalOutputSafetyEventWriter(inner, {
      checkText,
      chunkThreshold: 0,
    });
    const sinkSpy = vi.spyOn(inner, 'pushRuntime');
    await writer.pushRuntime(contentChunk('问题内容1'));
    await writer.pushRuntime(finalMessageEvent('问题内容 final', 'msg_1'));
    expect(sinkSpy).not.toHaveBeenCalled();
    expect(captured).toEqual([]);
    // guide_prompt remains readable from internal writer state for the host to assemble systemPrompt.
    expect(writer.guideReviewed).toBe(true);
    expect(writer.consumeGuidePrompt()).toBe(SENTINEL_GUIDE_PROMPT);
  });

  it('metrics: guide review 决策记 decision=guide_review, 不计 output_safety_block_total', async () => {
    const checkText = vi.fn(
      async (): Promise<SafetyCheckResult> => ({
        pass: false,
        action: 'guide',
        reason: 'rejected',
        guide_prompt: SENTINEL_GUIDE_PROMPT,
        errorKind: 'rejected',
      }),
    );
    const { inner } = makeSink();
    const metrics = createLocalRuntimeMetricsClient({ runtimeOwnerKind: 'test' });
    const counterSpy = vi.spyOn(metrics, 'counter');
    const writer = new LocalOutputSafetyEventWriter(inner, {
      checkText,
      chunkThreshold: 0,
      metricsClient: metrics as LocalRuntimeMetricsClient,
    });
    await writer.pushRuntime(contentChunk('问题内容'));
    // Find the guide_review decision.
    const guideReviewCalls = counterSpy.mock.calls.filter(
      (c) =>
        c[0] === 'output_safety_check_total' &&
        (c[2] as { decision?: string } | undefined)?.decision === 'guide_review',
    );
    expect(guideReviewCalls.length).toBeGreaterThan(0);
    // There must be no decision=block.
    const blockCalls = counterSpy.mock.calls.filter(
      (c) =>
        c[0] === 'output_safety_check_total' &&
        (c[2] as { decision?: string } | undefined)?.decision === 'block',
    );
    expect(blockCalls.length).toBe(0);
    // Do not increment output_safety_block_total; guide review is not a hard block.
    const blockTotalCalls = counterSpy.mock.calls.filter(
      (c) => c[0] === 'output_safety_block_total',
    );
    expect(blockTotalCalls.length).toBe(0);
  });
  it('ignores a guide without an explicit Review and leaves the SR fallback active', async () => {
    const { inner } = makeSink();
    const writer = new LocalOutputSafetyEventWriter(inner, {
      checkText: async () => ({
        pass: false,
        errorKind: 'rejected',
        guide_prompt: SENTINEL_GUIDE_PROMPT,
      }),
      chunkThreshold: 0,
    });
    await writer.pushRuntime(contentChunk('legacy rejected draft'));
    expect(writer.blocked).toBe(true);
    expect(writer.immediateBlock).toBe(false);
    expect(writer.guideReviewed).toBe(false);
    expect(writer.consumeGuidePrompt()).toBeUndefined();
  });

  it.each([
    { apiVersion: undefined, instruction: OUTPUT_REVISION_INSTRUCTION },
    { apiVersion: 'v2' as const, instruction: SENTINEL_GUIDE_PROMPT },
  ])(
    'uses the correct regeneration instruction for API $apiVersion',
    async ({ apiVersion, instruction }) => {
      const prompts: string[] = [];
      let reviews = 0;
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockImplementation(async () => {
          const rejected = reviews++ === 0;
          if (apiVersion === 'v2') {
            return Response.json(
              rejected
                ? { action: 4, errorCode: 50201, guide_prompt: SENTINEL_GUIDE_PROMPT }
                : { action: 1 },
            );
          }
          return Response.json(
            rejected
              ? {
                  pass: false,
                  decision: 'review',
                  errorCode: 50201,
                  guide_prompt: SENTINEL_GUIDE_PROMPT,
                }
              : { pass: true, decision: 'pass' },
          );
        });
      const piRunner: LocalTurnRunner = {
        async runTurn(input) {
          prompts.push(input.systemPrompt);
          await input.eventWriter.pushRuntime(finalMessageEvent('draft'));
        },
      };
      const host = new LocalRuntimeHost({ piRunner, fetchImpl, safetyApiVersion: apiVersion });
      const output = await host.runTurn({
        sessionId: 'ses_1',
        turnId: 'turn_1',
        workspaceDir: '/tmp/workspace',
        systemPrompt: 'base prompt',
        userMessage: { text: 'hello' },
        llm: { model: {} as never },
        rewindPiHistory: async () => {},
      });
      expect(prompts).toEqual(['base prompt', `base prompt\n\n${instruction}`]);
      expect(output.retracted).toBe(false);
      expect(fetchImpl.mock.calls[0]?.[0]).toMatch(
        apiVersion === 'v2' ? /\/v2\/content\?require_auth=true$/ : /\/v1\/content$/,
      );
      expect(JSON.stringify(output.events)).not.toContain(SENTINEL_GUIDE_PROMPT);
    },
  );
});

describe('callSafetyApi preserves the V1 response contract', () => {
  it.each([
    { pass: false, guide: SENTINEL_GUIDE_PROMPT },
    { pass: true, guide: SENTINEL_GUIDE_PROMPT },
    { pass: false, guide: '' },
    { pass: false, guide: '   ' },
    { pass: false, guide: 12345 },
    { pass: false, guide: null },
  ])('ignores V2-only fields from a V1 response: %j', async ({ pass, guide }) => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({
        pass,
        decision: 'review',
        action: 'guide',
        guide_prompt: guide,
        ...(pass ? {} : { errorCode: 50201 }),
      }),
    );
    const result = await callSafetyApi({
      content: 'test',
      scene: SAFETY_SCENE.MessageOutput,
      fetchImpl,
      region: () => 'cn',
      buildEnv: () => 'test',
    });
    expect(result.pass).toBe(pass);
    expect(result).not.toHaveProperty('guide_prompt');
    expect(result).not.toHaveProperty('decision');
    expect(result).not.toHaveProperty('action');
    expect(result.errorKind).toBe(pass ? undefined : 'rejected');
    expect(fetchImpl.mock.calls[0]?.[0]).toMatch(/\/v1\/content$/);
  });
});
