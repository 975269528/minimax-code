const MAX_AGENT_NAME_LENGTH = 64;
const WINDOWS_RESERVED_AGENT_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;

export class LocalAgentContractError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'LocalAgentContractError';
  }
}

export function validateAgentName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new LocalAgentContractError(400, 'Agent name is required', 'VALIDATION_ERROR');
  }
  if (
    trimmed !== name ||
    trimmed.length > MAX_AGENT_NAME_LENGTH ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed === '.' ||
    trimmed === '..' ||
    trimmed.endsWith('.') ||
    WINDOWS_RESERVED_AGENT_NAMES.test(trimmed) ||
    /[\u0000-\u001f\u007f]/u.test(trimmed)
  ) {
    throw new LocalAgentContractError(
      400,
      'Agent name contains invalid characters',
      'VALIDATION_ERROR',
    );
  }
  return trimmed;
}

export function parseExplicitStableName(value: string): string {
  if (!value.toLowerCase().startsWith('agent:')) return validateAgentName(value);
  const stable = value.slice('agent:'.length);
  if (!stable) {
    throw new LocalAgentContractError(400, 'Agent name is required', 'VALIDATION_ERROR');
  }
  return validateAgentName(stable);
}
