import { LocalOutputSafetyEventWriter } from '../../src/runtime/output-safety-writer.js';
import { RuntimeEventType, type IRuntimeEvent } from '@mavis/protocol';
import { RespDataType } from '@mavis/agent-core/protocol/agent-message';
import { describe, expect, it, vi } from 'vitest';
import { createContentSafetyChecker, SAFETY_SCENE } from '../../src/content-safety/api.js';

const deps = {
  apiVersion: 'v2' as const,
  region: () => 'cn' as const,
  buildEnv: () => 'test' as const,
};

describe('production turn safety routing', () => {
  it.each([undefined, '', '  '])('normalizes an empty input guide before runtime delivery: %j', async (guide) => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({
      action: 4, errorCode: 50201, ...(guide !== undefined ? { guide_prompt: guide } : {}),
    }));
    const checker = createContentSafetyChecker({ ...deps, fetchImpl });
    expect(await checker('query', SAFETY_SCENE.UserInput)).toEqual({ pass: true, action: 'allow' });
    for (const scene of [SAFETY_SCENE.MessageOutput, SAFETY_SCENE.StreamChunk, SAFETY_SCENE.ThinkingContent]) {
      expect(await checker('draft', scene)).toEqual({ pass: false, action: 'guide', errorKind: 'rejected' });
    }
  });

  it.each(
    [
      { body: { action: 1 }, blocked: false, immediate: false },
      {
        body: { action: 2, errorCode: 50201, guide_prompt: 'ignored' },
        blocked: true,
        immediate: true,
      },
      {
        body: { action: 4, errorCode: 50201, guide_prompt: 'model guide' },
        blocked: true,
        immediate: false,
        guide: 'model guide',
      },
      { body: { action: 4, errorCode: 50201 }, blocked: true, immediate: false },
      {
        body: { action: 4, errorCode: 50201, guide_prompt: '  ' },
        blocked: true,
        immediate: false,
      },
    ].flatMap((testCase) => [
      { ...testCase, thinking: false },
      { ...testCase, thinking: true },
    ]),
  )(
    'applies HTTP action $body.action at the output boundary (thinking=$thinking)',
    async ({ body, blocked, immediate, guide, thinking }) => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockImplementation(async () => Response.json(body));
      const pushRuntime = vi.fn();
      const appendEvents = vi.fn();
      const writer = new LocalOutputSafetyEventWriter(
        { pushRuntime, appendEvents },
        { checkText: createContentSafetyChecker({ ...deps, fetchImpl }), chunkThreshold: 1 },
      );
      await writer.pushRuntime({
        schema: 'runtime.event/v1',
        event_id: 'action-chunk',
        type: RuntimeEventType.STREAM_RESP,
        payload: {
          stream_resp: JSON.stringify({
            type: RespDataType.AgentMessageChunk,
            agent_message_chunk: {
              msg_id: 'm',
              ...(thinking ? { thinking_content: 'draft' } : { msg_content: 'draft' }),
            },
          }),
        },
      } as IRuntimeEvent);
      expect(writer.blocked).toBe(blocked);
      expect(writer.immediateBlock).toBe(immediate);
      expect(writer.networkStopped).toBe(false);
      // An empty guide leaves regeneration eligible and selects the existing SR.
      expect(writer.consumeGuidePrompt()).toBe(guide);
      expect(writer.consumeGuidePrompt()).toBeUndefined();
      expect(pushRuntime).not.toHaveBeenCalled();
      expect(appendEvents).toHaveBeenCalledTimes(blocked ? 0 : 1);
      if (!blocked) {
        expect(appendEvents).toHaveBeenCalledWith([
          expect.objectContaining({ event_id: 'action-chunk' }),
        ]);
      }
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(fetchImpl.mock.calls.at(-1)?.[0]).toMatch(
        /\/mavis\/api\/v2\/content\?require_auth=true$/,
      );
      expect(JSON.parse(String(fetchImpl.mock.calls.at(-1)?.[1]?.body))).toEqual({
        content_text: 'draft',
        scene: thinking ? 13 : 11,
      });
    },
  );

  it('retains the V1 endpoint and payload unless V2 is explicitly selected', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({ pass: true, decision: 'pass' }));
    const legacyDeps = { region: deps.region, buildEnv: deps.buildEnv };
    const checker = createContentSafetyChecker({ ...legacyDeps, fetchImpl });
    expect(await checker('text', SAFETY_SCENE.UserInput)).toMatchObject({ pass: true });
    expect(fetchImpl.mock.calls[0]?.[0]).toMatch(/\/mavis\/api\/v1\/content$/);
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      content_text: 'text',
      scene: 300,
    });
  });

  it.each([
    { action: 4, errorCode: 50201, guide_prompt: 'thinking guide' },
    { action: 2, errorCode: 50201 },
  ])('keeps DesktopThinking scene 13 after a V2 transport error before action $action', async (body) => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () => new Response('{}', { status: 503 }))
      .mockImplementationOnce(async () => Response.json(body));
    const inner = { pushRuntime: vi.fn(), appendEvents: vi.fn() };
    const writer = new LocalOutputSafetyEventWriter(inner, {
      checkText: createContentSafetyChecker({ ...deps, fetchImpl }),
      retryDelay: async () => {},
      chunkThreshold: 1,
    });
    await writer.pushRuntime({
      schema: 'runtime.event/v1',
      event_id: 'thinking-retry',
      type: RuntimeEventType.STREAM_RESP,
      payload: {
        stream_resp: JSON.stringify({
          type: RespDataType.AgentMessageChunk,
          agent_message_chunk: { msg_id: 'm', thinking_content: 'thinking draft' },
        }),
      },
    } as IRuntimeEvent);
    expect(fetchImpl.mock.calls.map(([url]) => String(url).split('/api/')[1])).toEqual([
      'v2/content?require_auth=true',
      'v2/content?require_auth=true',
    ]);
    expect(fetchImpl.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      { content_text: 'thinking draft', scene: 13 },
      { content_text: 'thinking draft', scene: 13 },
    ]);
    expect(writer.blocked).toBe(true);
    expect(writer.networkStopped).toBe(false);
    expect(writer.immediateBlock).toBe(body.action === 2);
    expect(writer.consumeGuidePrompt()).toBe(body.action === 4 ? 'thinking guide' : undefined);
    expect(writer.consumeGuidePrompt()).toBeUndefined();
    expect(inner.pushRuntime).not.toHaveBeenCalled();
    expect(inner.appendEvents).not.toHaveBeenCalled();
  });

  it('keeps retries of a failed V2 window on V2 even if V1 would now allow', async () => {
    let v2Calls = 0;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      if (String(url).includes('/v1/content')) return Response.json({ pass: false });
      return ++v2Calls === 1
        ? new Response('{}', { status: 503 })
        : Response.json({ action: 2, errorCode: 50201 });
    });
    const writer = new LocalOutputSafetyEventWriter(
      { pushRuntime: vi.fn(), appendEvents: vi.fn() },
      {
        checkText: createContentSafetyChecker({ ...deps, fetchImpl }),
        retryDelay: async () => {},
        chunkThreshold: 1,
      },
    );
    await writer.pushRuntime({
      schema: 'runtime.event/v1',
      event_id: 'chunk',
      type: RuntimeEventType.STREAM_RESP,
      payload: {
        stream_resp: JSON.stringify({
          type: RespDataType.AgentMessageChunk,
          agent_message_chunk: { msg_id: 'm', msg_content: 'draft' },
        }),
      },
    } as IRuntimeEvent);
    expect(fetchImpl.mock.calls.map(([url]) => String(url).split('/api/')[1])).toEqual([
      'v2/content?require_auth=true',
      'v2/content?require_auth=true',
    ]);
    expect(writer.immediateBlock).toBe(true);
  });
  it.each([
    [SAFETY_SCENE.UserInput, 110],
    [SAFETY_SCENE.MessageOutput, 11],
    [SAFETY_SCENE.ThinkingContent, 13],
    [SAFETY_SCENE.StreamChunk, 11],
  ] as const)('uses V2 for scene %s', async (scene, wireScene) => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        Response.json({ action: 4, errorCode: 50201, guide_prompt: 'MODEL_ONLY' }),
      );
    const result = await createContentSafetyChecker({ ...deps, fetchImpl })('text', scene);
    expect(result).toEqual({
      pass: false,
      action: 'guide',
      errorKind: 'rejected',
      guide_prompt: 'MODEL_ONLY',
    });
    expect(fetchImpl.mock.calls[0]?.[0]).toMatch(/\/mavis\/api\/v2\/content\?require_auth=true$/);
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      content_text: 'text',
      scene: wireScene,
    });
  });

  it('keeps ConfigField on its existing V1 endpoint', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({ pass: true, decision: 'pass' }));
    expect(
      await createContentSafetyChecker({ ...deps, fetchImpl })('text', SAFETY_SCENE.ConfigField),
    ).toMatchObject({ pass: true });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[0]).toMatch(/\/mavis\/api\/v1\/content$/);
  });

  it('sends a streaming output window directly to V2 as an assistant reply', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        Response.json({ action: 4, errorCode: 50201, guide_prompt: 'model guide' }),
      );
    expect(
      await createContentSafetyChecker({ ...deps, fetchImpl })('draft', SAFETY_SCENE.StreamChunk),
    ).toEqual({
      pass: false,
      action: 'guide',
      guide_prompt: 'model guide',
      errorKind: 'rejected',
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[0]).toMatch(/\/mavis\/api\/v2\/content\?require_auth=true$/);
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      content_text: 'draft',
      scene: 11,
    });
  });

  it.each([401, 403] as const)(
    'keeps a streaming output window on V2 after HTTP %s refresh',
    async (status) => {
      let accessToken = 'expired-token';
      let v2Calls = 0;
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url) => {
        expect(String(url)).toContain('/v2/content?require_auth=true');
        v2Calls += 1;
        return v2Calls === 1
          ? new Response('{}', { status })
          : Response.json({ action: 2, errorCode: 50201 });
      });
      const authContextInvalidator = vi.fn(async () => {
        accessToken = 'fresh-token';
      });
      const result = await createContentSafetyChecker({
        ...deps,
        fetchImpl,
        authContextGetter: () => ({ accessToken }),
        authContextInvalidator,
      })('draft', SAFETY_SCENE.StreamChunk);

      expect(result).toMatchObject({
        pass: false,
        action: 'reject',
        errorKind: 'rejected',
      });
      expect(authContextInvalidator).toHaveBeenCalledOnce();
      expect(authContextInvalidator).toHaveBeenCalledWith('expired-token');
      expect(fetchImpl.mock.calls.map(([url]) => String(url).split('/api/')[1])).toEqual([
        'v2/content?require_auth=true',
        'v2/content?require_auth=true',
      ]);
      expect(fetchImpl.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
        { content_text: 'draft', scene: 11 },
        { content_text: 'draft', scene: 11 },
      ]);
      expect(new Headers(fetchImpl.mock.calls[1]?.[1]?.headers).get('Authorization')).toBe(
        'Bearer fresh-token',
      );
    },
  );

  it.each([401, 403])(
    'preserves ConfigField V1 routing on an initial HTTP %s refresh',
    async (status) => {
      let accessToken = 'expired-token';
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockImplementationOnce(async () => new Response('{}', { status }))
        .mockImplementationOnce(async () => Response.json({ pass: true }));
      const authContextInvalidator = vi.fn(async () => {
        accessToken = 'fresh-token';
      });
      const result = await createContentSafetyChecker({
        ...deps,
        fetchImpl,
        authContextGetter: () => ({ accessToken }),
        authContextInvalidator,
      })('draft', SAFETY_SCENE.ConfigField);

      expect(result).toMatchObject({ pass: true });
      expect(authContextInvalidator).toHaveBeenCalledOnce();
      expect(authContextInvalidator).toHaveBeenCalledWith('expired-token');
      expect(fetchImpl.mock.calls.map(([url]) => String(url).split('/api/')[1])).toEqual([
        'v1/content',
        'v1/content',
      ]);
      expect(fetchImpl.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
        { content_text: 'draft', scene: SAFETY_SCENE.ConfigField },
        { content_text: 'draft', scene: SAFETY_SCENE.ConfigField },
      ]);
      expect(new Headers(fetchImpl.mock.calls[1]?.[1]?.headers).get('Authorization')).toBe(
        'Bearer fresh-token',
      );
    },
  );

  it.each([
    [SAFETY_SCENE.UserInput, 110],
    [SAFETY_SCENE.ThinkingContent, 13],
    [SAFETY_SCENE.MessageOutput, 11],
    [SAFETY_SCENE.StreamChunk, 11],
  ] as const)('preserves V2 scene %s after authentication refresh', async (scene, wireScene) => {
    let accessToken = 'expired-token';
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () => new Response('{}', { status: 401 }))
      .mockImplementationOnce(async () => Response.json({ action: 1 }));
    const result = await createContentSafetyChecker({
      ...deps,
      fetchImpl,
      authContextGetter: () => ({ accessToken }),
      authContextInvalidator: async () => {
        accessToken = 'fresh-token';
      },
    })('text', scene);

    expect(result).toMatchObject({ pass: true, action: 'allow' });
    expect(fetchImpl.mock.calls.map(([url]) => String(url).split('/api/')[1])).toEqual([
      'v2/content?require_auth=true',
      'v2/content?require_auth=true',
    ]);
    expect(fetchImpl.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      { content_text: 'text', scene: wireScene },
      { content_text: 'text', scene: wireScene },
    ]);
  });

  it.each([400, 401, 503])(
    'does not downgrade a failed V2 streaming output review to V1 allow (HTTP %s)',
    async (status) => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockImplementation(async () => new Response('{}', { status }));
      const result = await createContentSafetyChecker({ ...deps, fetchImpl })(
        'draft',
        SAFETY_SCENE.StreamChunk,
      );
      expect(result).toMatchObject({
        pass: false,
        errorKind: status === 401 ? 'auth_error' : 'local_error',
      });
      expect(fetchImpl).toHaveBeenCalledOnce();
    },
  );

  it('keeps default V1 thinking on scene 3 without consuming extra guide fields', async () => {
    const legacyDeps = { region: deps.region, buildEnv: deps.buildEnv };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        Response.json({ pass: false, guide_prompt: 'ignored V1 guide' }),
      );
    expect(
      await createContentSafetyChecker({ ...legacyDeps, fetchImpl })(
        'thinking',
        SAFETY_SCENE.ThinkingContent,
      ),
    ).toEqual({ pass: false, errorKind: 'rejected' });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[0]).toMatch(/\/mavis\/api\/v1\/content$/);
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      content_text: 'thinking',
      scene: 3,
    });
  });
});
