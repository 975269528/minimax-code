import fs from 'node:fs';
import path from 'node:path';

import { logger } from '../common/logger.js';

export const PROJECT_INSTRUCTIONS_MAX_BYTES = 32 * 1024;

const PROJECT_INSTRUCTIONS_FILENAME = 'AGENTS.md';
const TRUNCATION_NOTICE = [
  `[${PROJECT_INSTRUCTIONS_FILENAME} content truncated by local-runtime to fit the ${PROJECT_INSTRUCTIONS_MAX_BYTES}-byte UTF-8 project instructions budget.`,
  `Read the source ${PROJECT_INSTRUCTIONS_FILENAME} file directly when the omitted instructions are needed.]`,
].join('\n');

export interface ProjectInstructions {
  filename: typeof PROJECT_INSTRUCTIONS_FILENAME;
  content: string;
  originalBytes: number;
  injectedBytes: number;
  truncated: boolean;
}

/** Detect the workspace's AGENTS.md instructions file. */
export function detectProjectInstructions(workspaceDir: string): string | undefined {
  const agentsPath = path.join(workspaceDir, PROJECT_INSTRUCTIONS_FILENAME);
  try {
    fs.statSync(agentsPath);
    return PROJECT_INSTRUCTIONS_FILENAME;
  } catch {
    return undefined;
  }
}

/** Read the workspace's AGENTS.md within the shared project-instructions byte budget. */
export function readProjectInstructions(workspaceDir: string): ProjectInstructions | undefined {
  const agentsPath = path.join(workspaceDir, PROJECT_INSTRUCTIONS_FILENAME);
  try {
    const source = fs.readFileSync(agentsPath);
    const originalBytes = source.byteLength;
    const decodedContent = source.toString('utf8').trim();
    const normalizedSource = Buffer.from(decodedContent, 'utf8');
    const truncated = normalizedSource.byteLength > PROJECT_INSTRUCTIONS_MAX_BYTES;
    const content = truncated ? truncateProjectInstructions(normalizedSource) : decodedContent;
    if (!content) return undefined;

    const instructions: ProjectInstructions = {
      filename: PROJECT_INSTRUCTIONS_FILENAME,
      content,
      originalBytes,
      injectedBytes: Buffer.byteLength(content, 'utf8'),
      truncated,
    };
    if (truncated) {
      logger.warn(
        {
          filename: PROJECT_INSTRUCTIONS_FILENAME,
          originalBytes: instructions.originalBytes,
          injectedBytes: instructions.injectedBytes,
          maxBytes: PROJECT_INSTRUCTIONS_MAX_BYTES,
        },
        'Project instructions exceeded the prompt budget and were truncated',
      );
    }
    return instructions;
  } catch {
    return undefined;
  }
}

function truncateProjectInstructions(source: Buffer): string {
  const separator = '\n\n';
  const noticeBytes = Buffer.byteLength(separator + TRUNCATION_NOTICE, 'utf8');
  const contentBudget = PROJECT_INSTRUCTIONS_MAX_BYTES - noticeBytes;
  let prefix = decodeUtf8Prefix(source, contentBudget).trimEnd();
  const lastNewline = prefix.lastIndexOf('\n');
  if (lastNewline >= Math.floor(prefix.length * 0.8)) {
    prefix = prefix.slice(0, lastNewline).trimEnd();
  }
  return `${prefix}${separator}${TRUNCATION_NOTICE}`;
}

function decodeUtf8Prefix(source: Buffer, maxBytes: number): string {
  let end = Math.min(source.byteLength, maxBytes);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  while (end > 0) {
    try {
      return decoder.decode(source.subarray(0, end));
    } catch {
      end -= 1;
    }
  }
  return '';
}
