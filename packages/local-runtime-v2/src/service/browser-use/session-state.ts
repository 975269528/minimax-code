import { createHash } from 'node:crypto';

import type { LocalBrowserSkillSessionStore } from '@mavis/agent-tools/desktop';

import type {
  BrowserTurnContextCapability,
  BrowserTurnContextRecordInput,
  InAppBrowserSurfaceState,
} from './contracts.js';

export class BrowserSkillSessionStore implements LocalBrowserSkillSessionStore {
  private readonly loadedContentDigests = new Map<string, string | undefined>();

  hasLoaded(sessionId: string, expectedContent?: string): boolean {
    return (
      this.loadedContentDigests.has(sessionId) &&
      (expectedContent === undefined ||
        this.loadedContentDigests.get(sessionId) === contentDigest(expectedContent))
    );
  }

  markLoaded(sessionId: string, content?: string): void {
    this.loadedContentDigests.set(
      sessionId,
      content === undefined ? undefined : contentDigest(content),
    );
  }

  clearSession(sessionId: string): void {
    this.loadedContentDigests.delete(sessionId);
  }

  clear(): void {
    this.loadedContentDigests.clear();
  }
}

function contentDigest(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

interface StoredBrowserTurnContext {
  readonly turnId: string;
  readonly inAppBrowser: InAppBrowserSurfaceState;
}

export class BrowserTurnContextStore implements BrowserTurnContextCapability {
  private readonly records = new Map<string, StoredBrowserTurnContext>();

  record(input: BrowserTurnContextRecordInput): void {
    if (!input.sessionId.trim()) throw new TypeError('sessionId must be a non-empty string');
    if (!input.turnId.trim()) throw new TypeError('turnId must be a non-empty string');
    assertInAppBrowserSurfaceState(input.inAppBrowser);
    this.records.set(input.sessionId, {
      turnId: input.turnId,
      inAppBrowser: { ...input.inAppBrowser },
    });
  }

  read(sessionId: string, turnId: string | undefined): InAppBrowserSurfaceState | undefined {
    if (!turnId) return undefined;
    const record = this.records.get(sessionId);
    if (!record || record.turnId !== turnId) return undefined;
    return { ...record.inAppBrowser };
  }

  clearSession(sessionId: string): void {
    this.records.delete(sessionId);
  }

  clear(): void {
    this.records.clear();
  }
}

function assertInAppBrowserSurfaceState(value: unknown): asserts value is InAppBrowserSurfaceState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('inAppBrowser must be an object');
  }
  const state = value as Record<string, unknown>;
  if (typeof state.visible !== 'boolean') {
    throw new TypeError('inAppBrowser.visible must be a boolean');
  }
  if (typeof state.selectedTab !== 'boolean') {
    throw new TypeError('inAppBrowser.selectedTab must be a boolean');
  }
}
