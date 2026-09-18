import type { GlobalEventPublisher } from '../events.js';
import type { ConversationModelThinkingSelection } from '@mavis/conversation-contract';
import type { FrozenAgentExecutionDefinition } from '../../service/session-system/index.js';
import type {
  LocalModelProviderService,
  LocalRuntimeConfig,
  ManagedModelParameterSnapshot,
} from '../../service/model-system/index.js';

export interface ModelProviderSessionView {
  /** Trusted persisted definition, omitted from public model projections. */
  readonly frozenModel?: FrozenAgentExecutionDefinition['model'];
  readonly effectiveModelContextWindow?: number | null;
  readonly effectiveModel?: string | null;
  readonly effectiveModelVariant?: string | null;
  readonly effectiveModelThinking?: ConversationModelThinkingSelection | null;
}

export interface ModelProviderSessionPort {
  get(sessionId: string): Promise<ModelProviderSessionView | undefined>;
  update(
    sessionId: string,
    fields: {
      readonly modelParameterSnapshot?: ManagedModelParameterSnapshot;
      readonly effectiveModelContextWindow?: number | null;
      readonly effectiveModelMaxOutputTokens?: number | null;
      readonly effectiveModel: string;
      readonly effectiveModelVariant: string | null;
      readonly effectiveModelThinking?: ConversationModelThinkingSelection | null;
    },
  ): Promise<unknown>;
}

export interface ModelProviderApplicationDeps {
  readonly publish?: GlobalEventPublisher;
  readonly config: () => LocalRuntimeConfig;
  readonly providers: LocalModelProviderService;
  readonly sessions: ModelProviderSessionPort;
  readonly setDefaultModel: (
    modelKey: string,
    variant?: string,
    selection?: {
      readonly contextLimit?: number;
      readonly thinking?: ConversationModelThinkingSelection;
    },
  ) => Promise<void>;
  readonly refreshOfficialModels?: () => Promise<void>;
  readonly implicitCustomProviderThinking?: boolean;
  readonly tuiProductPolicy?: boolean;
}

export interface SelectRuntimeModelInput {
  readonly reasoning?: boolean;
  readonly replaceSelection?: boolean;
  readonly contextLimit?: number;
  readonly sessionId?: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly variant?: string;
  readonly thinking?: ConversationModelThinkingSelection | null;
}
