import { createHash } from 'node:crypto';

import type { PromptConfigAuthProvider, PromptConfigAuthSnapshot } from '../contracts.js';

export interface PromptConfigRuntimeAuthContext {
  readonly accessToken?: string;
  readonly realUserID?: string;
}

export interface RuntimePromptConfigAuthProviderOptions {
  readonly authContextGetter: () => PromptConfigRuntimeAuthContext | undefined;
  readonly deploymentGetter: () => string;
}

/** Captures one credential generation without retaining it outside an active snapshot. */
export class RuntimePromptConfigAuthProvider implements PromptConfigAuthProvider {
  private fingerprint: string | undefined;
  private generation = 0;

  constructor(private readonly options: RuntimePromptConfigAuthProviderOptions) {}

  capture(): PromptConfigAuthSnapshot {
    const deployment = this.options.deploymentGetter().trim();
    const context = this.options.authContextGetter();
    const accessToken = context?.accessToken?.trim();
    const realUserID = context?.realUserID?.trim();
    const loggedIn = Boolean(deployment && accessToken && realUserID);
    const fingerprint = loggedIn
      ? `account\0${deployment}\0${realUserID}\0${accessToken}`
      : `anonymous\0${deployment}`;
    if (this.fingerprint !== undefined && this.fingerprint !== fingerprint) this.generation += 1;
    this.fingerprint = fingerprint;
    if (!loggedIn) {
      return {
        scopeId: 'anonymous',
        subject: 'anonymous',
        keyVersion: 'desktop-v1',
        generation: this.generation,
      };
    }
    return {
      scopeId: createHash('sha256').update(`${deployment}\0${realUserID}`, 'utf8').digest('hex'),
      subject: realUserID as string,
      keyVersion: 'desktop-v1',
      accessToken: accessToken as string,
      generation: this.generation,
    };
  }

  authContextChanged(): void {
    this.generation += 1;
    this.fingerprint = undefined;
  }
}
