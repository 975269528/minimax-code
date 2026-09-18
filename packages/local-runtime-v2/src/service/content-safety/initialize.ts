import {
  ContentSafetyService,
  type ContentSafetyServiceOptions,
} from './content-safety.service.js';

export function initializeContentSafetyService(
  options: ContentSafetyServiceOptions,
): ContentSafetyService {
  return new ContentSafetyService(options);
}
