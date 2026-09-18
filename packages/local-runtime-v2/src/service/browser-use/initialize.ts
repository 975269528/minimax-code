import { LocalBrowserUseService } from './browser-use.service.js';
import type { BrowserUseService, BrowserUseServiceOptions } from './contracts.js';

export function initializeBrowserUseService(options: BrowserUseServiceOptions): BrowserUseService {
  return new LocalBrowserUseService(options);
}
