import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

import { MCODE_OAUTH_CLIENT_ID, type AuthNamespaceInput } from './contracts.js';
import type { CredentialKey } from './credential-store/types.js';

export interface AuthNamespace {
  authHome: string;
  namespaceHome: string;
  lockPath: string;
  statePath: string;
  credentialPath: string;
  legacyLockPath: string;
  legacyStatePath: string;
  legacyEncryptedCredentialPath: string;
  buildEnv: AuthNamespaceInput['buildEnv'];
  region: AuthNamespaceInput['region'];
  credentialKey: CredentialKey;
}

export function createAuthNamespace(input: AuthNamespaceInput): AuthNamespace {
  const authHome = join(resolve(input.dataDir), 'auth');
  const namespaceHome = join(authHome, input.buildEnv, input.region, MCODE_OAUTH_CLIENT_ID);
  const service = `com.minimax.mcode.oauth.${input.buildEnv}.${input.region}`;
  const account = createHash('sha256')
    .update(`${authHome}\0${MCODE_OAUTH_CLIENT_ID}`)
    .digest('base64url');

  return {
    authHome,
    namespaceHome,
    lockPath: join(namespaceHome, 'auth.lock'),
    statePath: join(namespaceHome, 'auth-state.json'),
    credentialPath: join(namespaceHome, 'auth.json'),
    legacyLockPath: join(authHome, 'auth.lock'),
    legacyStatePath: join(authHome, 'auth-state.json'),
    legacyEncryptedCredentialPath: join(authHome, 'credentials.enc'),
    buildEnv: input.buildEnv,
    region: input.region,
    credentialKey: { service, account },
  };
}
