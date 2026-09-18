import type { RuntimeConversation } from '@mavis/conversation-contract';
import { createRuntimeConversationApplication } from '../conversation/runtime-conversation-application.js';
import type { SessionSystemOwner } from '../../service/session-system/index.js';
import type { createRuntimeSkillApplication } from './runtime-skill-application.js';

type ConversationApplicationInput = Parameters<typeof createRuntimeConversationApplication>[0];
type SkillApplicationInput = Parameters<typeof createRuntimeSkillApplication>;

interface RuntimeUserApplicationOptions {
  readonly compatibility: {
    readonly attachmentRegistration: ConversationApplicationInput['attachmentRegistration'];
    readonly sessionV2: {
      readonly goals: {
        readonly pauseActiveForAbort: ConversationApplicationInput['pauseActiveForAbort'];
      };
    };
  };
  readonly metrics?: ConversationApplicationInput['metrics'];
}

interface RuntimeUserApplicationOwners {
  readonly turnSystem: ConversationApplicationInput['turnSystem'];
  readonly runtimeConversation: RuntimeConversation;
  readonly plugin: SkillApplicationInput[0];
}

export function createRuntimeUserApplications(input: {
  readonly options: RuntimeUserApplicationOptions;
  readonly owners: RuntimeUserApplicationOwners;
  readonly sessionSystem: SessionSystemOwner;
  readonly queryCollapseKeys: ConversationApplicationInput['queryCollapseKeys'];
  readonly agentSessionPorts: SkillApplicationInput[2];
  readonly nowMs: SkillApplicationInput[3];
  readonly createSkillApplication: typeof createRuntimeSkillApplication;
}) {
  return {
    conversation: createRuntimeConversationApplication({
      sessionSystem: input.sessionSystem,
      turnSystem: input.owners.turnSystem,
      runtimeConversation: input.owners.runtimeConversation,
      attachmentRegistration: input.options.compatibility.attachmentRegistration,
      pauseActiveForAbort: input.options.compatibility.sessionV2.goals.pauseActiveForAbort,
      metrics: input.options.metrics,
      queryCollapseKeys: input.queryCollapseKeys,
    }),
    skill: input.createSkillApplication(
      input.owners.plugin,
      input.sessionSystem.sessions.query,
      input.agentSessionPorts,
      input.nowMs,
    ),
  };
}
