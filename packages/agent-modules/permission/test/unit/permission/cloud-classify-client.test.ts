import { afterEach, describe, expect, it } from 'vitest';

import { getPermissionCheckApiUrl } from '../../../src/classifier/cloud-classify-client.js';
import {
  configurePermissionHost,
  resetPermissionHostForTesting,
} from '../../../src/host-utils.js';

describe('getPermissionCheckApiUrl', () => {
  afterEach(() => {
    resetPermissionHostForTesting();
  });

  it('uses the China production domain for Desktop permission checks', () => {
    configurePermissionHost({
      runtimeConfigProvider: {
        getConfig: () => {
          throw new Error('not needed by endpoint resolution');
        },
        getRuntimeRegion: () => 'cn',
        getRuntimeBuildEnv: () => 'prod',
        isManagedRuntime: () => true,
      },
    });

    expect(getPermissionCheckApiUrl()).toBe(
      'https://agent.minimax.cn/mavis/api/v1/permission/check',
    );
  });
});
