import type { TuiAttachment } from '../types/invocation.js';

export interface TuiInvocation {
  content: string;
  attachments?: readonly TuiAttachment[];
}

export type { TuiAttachment } from '../types/invocation.js';
