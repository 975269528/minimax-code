import { describe, expect, it } from 'vitest';

import { createExecResult, isExecResult } from '../../src/headless/contract.js';

describe('mcode exec result contract', () => {
  it('emits the single schemaVersion=1 contract with parsed structured output', () => {
    const result = createExecResult(
      {
        sessionId: 'session-1',
        turnId: 'turn-1',
        status: 'succeeded',
        answer: '{"findings":[]}',
        usage: { inputTokens: 10, outputTokens: 2 },
        durationMs: 25,
      },
      {
        runId: 'run-1',
        outputSchema: {
          type: 'object',
          properties: { findings: { type: 'array' } },
          required: ['findings'],
        },
        model: {
          providerId: 'custom_provider:review',
          modelId: 'gpt',
          protocol: 'openai-responses',
          structuredOutputMode: 'native_strict',
        },
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      },
    );

    expect(result).toEqual({
      schemaVersion: 1,
      type: 'exec.result',
      runId: 'run-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      status: 'succeeded',
      output: { findings: [] },
      model: {
        providerId: 'custom_provider:review',
        modelId: 'gpt',
        protocol: 'openai-responses',
        structuredOutputMode: 'native_strict',
      },
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      durationMs: 25,
    });
    expect(isExecResult(result)).toBe(true);
  });

  it('fails closed when a Provider claims success with invalid structured output', () => {
    expect(
      createExecResult(
        {
          sessionId: 'session-1',
          turnId: 'turn-1',
          status: 'succeeded',
          answer: 'not json',
          durationMs: 25,
        },
        { runId: 'run-1', outputSchema: { type: 'object' } },
      ),
    ).toMatchObject({
      status: 'failed',
      error: { code: 'STRUCTURED_OUTPUT_INVALID' },
    });
  });

  it('validates parsed output against the requested schema', () => {
    expect(
      createExecResult(
        {
          sessionId: 'session-1',
          turnId: 'turn-1',
          status: 'succeeded',
          answer: '{"findings":"none"}',
          durationMs: 25,
        },
        {
          runId: 'run-1',
          outputSchema: {
            type: 'object',
            properties: { findings: { type: 'array' } },
            required: ['findings'],
          },
        },
      ),
    ).toMatchObject({
      status: 'failed',
      error: {
        code: 'STRUCTURED_OUTPUT_INVALID',
        message: expect.stringContaining('did not match --output-schema'),
      },
    });
  });

  it('never exposes an interactive blocked result', () => {
    expect(
      createExecResult(
        {
          sessionId: 'session-1',
          turnId: 'turn-1',
          status: 'awaiting-user-continuation',
          answer: null,
          durationMs: 25,
        },
        { runId: 'run-1' },
      ),
    ).toMatchObject({
      status: 'failed',
      error: { code: 'INTERACTION_NOT_AVAILABLE' },
    });
  });

  it('adds optional usage provenance without changing the numeric usage contract', () => {
    const result = createExecResult(
      { sessionId: 'session-1', turnId: 'turn-1', status: 'cancelled', durationMs: 25 },
      { runId: 'run-1', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 }, usageSource: 'completed_responses', usageIncomplete: true },
    );
    expect(result).toMatchObject({ usage: { totalTokens: 12 }, usageSource: 'completed_responses', usageIncomplete: true });
    expect(isExecResult(result)).toBe(true);
    expect(isExecResult({ ...result, usageSource: 'unknown' })).toBe(false);
    expect(isExecResult({ ...result, usageIncomplete: 'false' })).toBe(false);
  });
});
