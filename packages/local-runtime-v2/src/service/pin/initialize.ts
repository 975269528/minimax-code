import type { PinServiceOptions } from './contracts.js';
import { PinService } from './service.js';

export function initializePinService(options: PinServiceOptions): PinService {
  return new PinService(options);
}
