import type { PiAgentMessage } from '@mavis/agent-core/pi-turn-runner';
import {
  BACKGROUND_TASK_READ_SETTLEMENT_CUSTOM_TYPE,
  isBackgroundTaskReadSettlement,
} from '../../contracts.js';

export { isBackgroundTaskReadSettlement };

export function createBackgroundTaskReadSettlement(timestamp: number): PiAgentMessage {
  return {
    role: 'custom',
    customType: BACKGROUND_TASK_READ_SETTLEMENT_CUSTOM_TYPE,
    content: '',
    display: false,
    details: { version: 1 },
    hostMetadata: { providerVisibility: 'omit' },
    timestamp,
  } as PiAgentMessage;
}
