import { randomUUID } from 'node:crypto';

import { Type, validateToolArguments, type Tool, type ToolCall } from '@earendil-works/pi-ai';

import {
  completeTitleModelResponse,
  type TitleModelStream,
  type TitleResolvedModel,
} from './title-model-completion.js';
import {
  normalizeSessionTitleCandidate,
  type SessionTitleModel,
  type SessionTitleModelInput,
} from './session-title-service.js';
import type { SessionRecord } from '../repo/contract.js';

const SUBMIT_SESSION_TITLE = 'submit_session_title';
const SESSION_TITLE_TOOL: Tool = {
  name: SUBMIT_SESSION_TITLE,
  description: 'Submit the concise title for this Session.',
  parameters: Type.Object({ title: Type.String() }, { additionalProperties: false }),
};

export interface SessionTitleModelAdapterOptions<TAgentConfig, TModel> {
  readonly buildAgentConfig: (session: SessionRecord) => Promise<TAgentConfig>;
  readonly resolveModel: (input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly agentConfig: TAgentConfig;
  }) => Promise<TitleResolvedModel<TModel>>;
  readonly stream: TitleModelStream<TModel>;
  readonly nowMs?: () => number;
  readonly makeTurnId?: () => string;
}

/** Transport-neutral model adapter for normal first-turn title generation. */
export class SessionTitleModelAdapter<TAgentConfig, TModel> implements SessionTitleModel {
  private readonly makeTurnId: () => string;

  constructor(private readonly options: SessionTitleModelAdapterOptions<TAgentConfig, TModel>) {
    this.makeTurnId = options.makeTurnId ?? (() => `turn_title_${randomUUID()}`);
  }

  async summarize(input: SessionTitleModelInput): Promise<string | null> {
    const response = await completeTitleModelResponse(
      {
        buildAgentConfig: this.options.buildAgentConfig,
        resolveModel: this.options.resolveModel,
        stream: this.options.stream,
        nowMs: this.options.nowMs ?? Date.now,
      },
      {
        ...input,
        turnId: this.makeTurnId(),
        tools: [SESSION_TITLE_TOOL],
      },
    );
    if (response.content.some((part) => part.type === 'text' && part.text?.trim())) return null;
    const toolParts = response.content.filter((part) => part.type === 'toolCall');
    const call = toolParts[0];
    if (
      toolParts.length !== 1 ||
      !call ||
      !isToolCall(call) ||
      call.name !== SUBMIT_SESSION_TITLE
    ) {
      return null;
    }
    try {
      const validated = validateToolArguments(SESSION_TITLE_TOOL, call) as { title: string };
      return normalizeSessionTitleCandidate(validated.title);
    } catch {
      return null;
    }
  }
}

function isToolCall(input: {
  readonly type: string;
  readonly id?: string;
  readonly name?: string;
  readonly arguments?: Readonly<Record<string, unknown>>;
}): input is ToolCall {
  return (
    input.type === 'toolCall' &&
    typeof input.id === 'string' &&
    typeof input.name === 'string' &&
    input.arguments !== undefined
  );
}
