import type {
  ConversationAttachment,
  ConversationMessageInput,
} from '@mavis/conversation-contract';

interface AttachmentRegistrationReceipt {
  readonly assetId: string;
  readonly filePath: string;
}

export type RegisteredConversationAttachment = ConversationAttachment & {
  readonly registrationReceipt?: AttachmentRegistrationReceipt;
};

export interface V1ConversationAttachmentRegistrationPort {
  register(input: {
    readonly sessionId: string;
    readonly turnId?: string;
    readonly attachments: readonly ConversationAttachment[];
  }): Promise<readonly RegisteredConversationAttachment[]>;
  discard?(input: {
    readonly sessionId: string;
    readonly receipts: readonly AttachmentRegistrationReceipt[];
  }): Promise<void>;
}

interface MaterializedV1ConversationMessage {
  readonly message: ConversationMessageInput;
  readonly discardCreated: () => Promise<void>;
}

export interface V1ConversationAttachmentMaterializer {
  materialize(input: {
    readonly sessionId: string;
    readonly turnId?: string;
    readonly message: ConversationMessageInput;
  }): Promise<MaterializedV1ConversationMessage>;
}
