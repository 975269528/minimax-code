import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { runTuiExec, type TuiHeadlessRuntime } from '../../src/headless/runner.js';
import { ExecDiagnostics } from '../../src/headless/diagnostics.js';

describe('headless preparation cancellation', () => {
  it('stops before account access when cancelled during diagnostics preparation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mcode-cancel-diagnostics-'));
    const controller = new AbortController();
    const createDiagnostics = ExecDiagnostics.create;
    const create = vi.spyOn(ExecDiagnostics, 'create').mockImplementationOnce(async (...args) => {
      const diagnostics = await createDiagnostics(...args);
      controller.abort();
      return diagnostics;
    });
    const getAccountStatus = vi.fn();
    const shutdown = vi.fn(async () => false);
    try {
      await expect(runTuiExec(
        {
          prompt: 'Fix it', workspaceDir: '/workspace', version: 'test',
          diagnosticsDir: directory,
        },
        {
          runtime: { getAccountStatus } as unknown as TuiHeadlessRuntime,
          signal: controller.signal,
          shutdown,
          stdout: vi.fn(),
          stderr: vi.fn(),
        },
      )).resolves.toBe(130);
      expect(getAccountStatus).not.toHaveBeenCalled();
      expect(shutdown).toHaveBeenCalledOnce();
    } finally {
      create.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(['account', 'session', 'interaction', 'model'] as const)(
    'does not submit after cancellation during %s preparation',
    async (stage) => {
      const processRef = new EventEmitter();
      let enteredPreparation!: () => void;
      const entered = new Promise<void>((resolve) => {
        enteredPreparation = resolve;
      });
      let finishPreparation!: () => void;
      const preparing = new Promise<void>((resolve) => {
        finishPreparation = resolve;
      });
      const pause = async (currentStage: typeof stage) => {
        if (stage !== currentStage) return;
        enteredPreparation();
        await preparing;
      };
      const sendMessage = vi.fn(async function* () {
        yield { type: 'message' as const, message: { role: 'assistant' as const, content: 'done' } };
        yield { type: 'session-status' as const, status: 'finished' as const };
      });
      const runtime = {
        getAccountStatus: async () => {
          await pause('account');
          return { status: 'ready', managedTokenPresent: true, warnings: [] };
        },
        createSession: async () => {
          await pause('session');
          return { sessionId: 'session-1', workspaceDir: '/workspace' };
        },
        getPendingQuestionnaire: async () => {
          await pause('interaction');
          return undefined;
        },
        listPendingPermissions: async () => [],
        listModels: async () => {
          await pause('model');
          return [{ providerId: 'provider', modelId: 'model', selected: true, effortOptions: ['high'] }];
        },
        sendMessage,
        abortSession: vi.fn(async () => true),
      } as unknown as TuiHeadlessRuntime;
      const shutdown = vi.fn(async () => false);
      const execution = runTuiExec(
        { prompt: 'Fix it', workspaceDir: '/workspace', version: '0.1.0', effort: 'high' },
        { runtime, processRef, shutdown, stdout: vi.fn(), stderr: vi.fn() },
      );

      await entered;
      processRef.emit('SIGTERM');
      finishPreparation();

      await expect(execution).resolves.toBe(130);
      expect(sendMessage).not.toHaveBeenCalled();
      expect(shutdown).toHaveBeenCalledOnce();
      expect(processRef.eventNames()).toEqual([]);
    },
  );

  it('cancels an active Run once when the invocation signal and process signal both arrive', async () => {
    const processRef = new EventEmitter();
    const controller = new AbortController();
    let enteredRun!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredRun = resolve;
    });
    const abortSession = vi.fn(async () => true);
    const runtime = {
      getAccountStatus: async () => ({ status: 'ready', managedTokenPresent: true, warnings: [] }),
      createSession: async () => ({ sessionId: 'session-1', workspaceDir: '/workspace' }),
      getPendingQuestionnaire: async () => undefined,
      listPendingPermissions: async () => [],
      async *sendMessage(_request: unknown, signal?: AbortSignal) {
        yield { type: 'heartbeat' as const };
        enteredRun();
        await new Promise<void>((resolve) => {
          signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      },
      abortSession,
    } as unknown as TuiHeadlessRuntime;
    const shutdown = vi.fn(async () => false);
    const execution = runTuiExec(
      { prompt: 'Fix it', workspaceDir: '/workspace', version: '0.1.0' },
      { runtime, processRef, signal: controller.signal, shutdown, stdout: vi.fn(), stderr: vi.fn() },
    );

    await entered;
    controller.abort();
    processRef.emit('SIGTERM');

    await expect(execution).resolves.toBe(130);
    expect(abortSession).toHaveBeenCalledOnce();
    expect(shutdown).toHaveBeenCalledOnce();
    expect(processRef.eventNames()).toEqual([]);
  });

  it('stops Session pagination at the next preparation boundary after cancellation', async () => {
    const processRef = new EventEmitter();
    const listSessionPage = vi.fn(async () => ({ sessions: [], hasMore: false, nextCursor: '' }));
    listSessionPage.mockImplementationOnce(async () => {
      processRef.emit('SIGTERM');
      return { sessions: [], hasMore: true, nextCursor: 'page-2' };
    });
    const runtime = {
      getAccountStatus: async () => ({ status: 'ready', managedTokenPresent: true, warnings: [] }),
      listSessionPage,
      sendMessage: vi.fn(),
    } as unknown as TuiHeadlessRuntime;
    const shutdown = vi.fn(async () => false);

    await expect(runTuiExec(
      { prompt: 'Fix it', workspaceDir: '/workspace', version: '0.1.0', continueSession: true },
      { runtime, processRef, shutdown, stdout: vi.fn(), stderr: vi.fn() },
    )).resolves.toBe(130);

    expect(listSessionPage).toHaveBeenCalledOnce();
    expect(runtime.sendMessage).not.toHaveBeenCalled();
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it('keeps a cleanup failure visible when the invocation was already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const getAccountStatus = vi.fn();
    const stderr = vi.fn();
    const shutdown = vi.fn(async () => true);

    await expect(runTuiExec(
      { prompt: 'Fix it', workspaceDir: '/workspace', version: '0.1.0' },
      {
        runtime: { getAccountStatus } as unknown as TuiHeadlessRuntime,
        signal: controller.signal,
        shutdown,
        stdout: vi.fn(),
        stderr,
      },
    )).resolves.toBe(70);

    expect(getAccountStatus).not.toHaveBeenCalled();
    expect(shutdown).toHaveBeenCalledOnce();
    expect(stderr.mock.calls.flat().join('')).toContain('Runtime shutdown did not complete cleanly.');
  });
});
