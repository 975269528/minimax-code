import {
  DesktopMatrixClient,
  toLocalGatewayPath,
  type DesktopMatrixClientOptions,
} from '@mavis/agent-tools/desktop';

import type { LocalRuntimeAuthContext } from '../runtime/model-resolver.js';
import {
  managedBackendRoutingHeaders,
  type LocalRuntimeRoutingContext,
} from '../runtime/routing-headers.js';
import { getLocalMatrixEndpoint } from './matrix-env.js';

export interface LocalMatrixClientOptions extends Omit<
  DesktopMatrixClientOptions,
  'authContext' | 'endpoint'
> {
  authContext?: LocalRuntimeAuthContext;
  routingContextGetter?: () => LocalRuntimeRoutingContext | undefined;
}

export class LocalMatrixClient extends DesktopMatrixClient {
  constructor(options: LocalMatrixClientOptions = {}) {
    super({
      ...options,
      routingHeadersGetter: () => managedBackendRoutingHeaders(options.routingContextGetter?.()),
      ...(options.baseUrl ? {} : { endpoint: getLocalMatrixEndpoint() }),
    });
  }
}

export { toLocalGatewayPath };
