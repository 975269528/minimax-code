import type {
  AbortSessionReq,
  CliSendMessageReq,
  CliSendMessageOptions,
  CliService,
  ConversationSteerInput,
  ConversationSteerResult,
  ResumeSessionReq,
  SessionStreamFrameView,
} from '@mavis/local-runtime-v2/cli-service';

import { TuiFailure } from '../../failure.js';
import type { TuiConversationPort } from '../port.js';
import { projectTuiSessionStreamFrame, type TuiStreamEvent } from '../stream-events.js';

export class TuiConversationAccess implements TuiConversationPort {
  constructor(private readonly service: CliService) {}

  async *sendMessage(
    req: CliSendMessageReq,
    signal?: AbortSignal,
    options?: CliSendMessageOptions,
  ): AsyncGenerator<TuiStreamEvent> {
    signal?.throwIfAborted();
    const context = signal ? { signal } : {};
    const opened = options
      ? await this.service.sendMessage(req, context, options)
      : await this.service.sendMessage(req, context);
    if (!opened.ok) {
      throw new TuiFailure('runtime', opened.body.message, {
        code: opened.body.key,
        retryable: opened.status >= 500,
      });
    }
    const source = asAsyncFrames(opened.source)[Symbol.asyncIterator]();
    const close = () => void source.return?.(undefined);
    signal?.addEventListener('abort', close, { once: true });
    try {
      for await (const frame of { [Symbol.asyncIterator]: () => source }) {
        signal?.throwIfAborted();
        const event = projectTuiSessionStreamFrame(frame, req.turnId);
        if (event) yield event;
      }
    } finally {
      signal?.removeEventListener('abort', close);
      await source.return?.(undefined);
    }
  }

  async abortSession(req: AbortSessionReq): Promise<boolean> {
    return (await this.service.abortSession(req)).success === true;
  }

  async *resumeSession(
    req: ResumeSessionReq,
    fallbackTurnId: string,
    signal?: AbortSignal,
  ): AsyncGenerator<TuiStreamEvent> {
    signal?.throwIfAborted();
    const opened = await this.service.resumeSession(req, signal ? { signal } : {});
    if (!opened.ok) {
      throw new TuiFailure('runtime', opened.body.message, {
        code: opened.body.key,
        retryable: opened.status >= 500,
      });
    }
    const source = asAsyncFrames(opened.source)[Symbol.asyncIterator]();
    const close = () => void source.return?.(undefined);
    signal?.addEventListener('abort', close, { once: true });
    try {
      for await (const frame of { [Symbol.asyncIterator]: () => source }) {
        signal?.throwIfAborted();
        const event = projectTuiSessionStreamFrame(frame, fallbackTurnId);
        if (event) yield event;
      }
    } finally {
      signal?.removeEventListener('abort', close);
      await source.return?.(undefined);
    }
  }

  steer(input: ConversationSteerInput): Promise<ConversationSteerResult> {
    return this.service.steer(input);
  }
}

async function* asAsyncFrames(
  source: AsyncIterable<SessionStreamFrameView> | Iterable<SessionStreamFrameView>,
): AsyncGenerator<SessionStreamFrameView> {
  for await (const frame of source) yield frame;
}
