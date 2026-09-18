import { HostConnectorGateway } from './gateway.js';
import type {
  HostConnectorSystemOptions,
  InitializedHostConnectorSystem,
} from './internal-contracts.js';

export function initializeHostConnectorSystem(
  options: HostConnectorSystemOptions,
): InitializedHostConnectorSystem {
  const gateway = new HostConnectorGateway(options);
  return {
    gateway,
    authContextChanged: () => gateway.authContextChanged(),
    close: () => gateway.close(),
  };
}
