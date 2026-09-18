import { createHash } from 'node:crypto';

import {
  type ContentSafetyReviewPort,
  type InputSafetyDecision,
  type SafetyCheckResult,
  type SafetyScene,
} from './contracts.js';

export interface ContentSafetyServiceOptions {
  readonly review: ContentSafetyReviewPort;
}

/**
 * Shared safety policy service. Business owners decide when a review is
 * required; the product compatibility layer owns how the verdict is fetched.
 */
export class ContentSafetyService {
  constructor(private readonly options: ContentSafetyServiceOptions) {}

  readonly review = async (content: string, scene: SafetyScene): Promise<SafetyCheckResult> => {
    try {
      return await this.options.review(content, scene);
    } catch {
      return { pass: false, errorKind: 'local_error' };
    }
  };

  async blocks(content: string, scene: SafetyScene): Promise<boolean> {
    if (!content.trim()) return false;
    return reviewBlocks(await this.review(content, scene));
  }
}

/** One fail policy: rejected/local failures block; gateway degradation passes. */
export function reviewBlocks(result: SafetyCheckResult): boolean {
  return !result.pass && result.errorKind !== 'api_error';
}

/** Review can be regenerated and a valid fixed answer can be delivered without the model. */
export function reviewBlocksInput(result: SafetyCheckResult): boolean {
  if (result.action === 'guide') return false;
  if (result.action === 'replace' && result.suggestion?.trim()) return false;
  return reviewBlocks(result);
}

export function digestSafetyInput(input: unknown): string {
  const serialized = JSON.stringify(canonicalValue(input)) ?? 'undefined';
  return `sha256:${createHash('sha256').update(serialized).digest('hex')}`;
}

export function isInputSafetyDecision(value: unknown): value is InputSafetyDecision {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const decision = value as Readonly<Record<string, unknown>>;
  return (
    typeof decision.inputDigest === 'string' &&
    /^sha256:[a-f0-9]{64}$/.test(decision.inputDigest) &&
    (decision.outcome === 'approved' || decision.outcome === 'degraded') &&
    Object.keys(decision).every((key) => key === 'inputDigest' || key === 'outcome')
  );
}

export function isInputSafetyDecisionFor(
  decision: unknown,
  inputDigest: string,
): decision is InputSafetyDecision {
  return isInputSafetyDecision(decision) && decision.inputDigest === inputDigest;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalValue(entry)]),
  );
}
