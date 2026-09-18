import type { ReviewConfig } from './config.js';

/** Keep the default configuration reference; mark only valid user choices as explicit configuration. */
export function parseReviewConfig(raw: unknown, defaults: ReviewConfig): ReviewConfig {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return defaults;
  }
  const mode = Reflect.get(raw, 'mode');
  return {
    mode: mode === 'inline' || mode === 'subagent' ? mode : defaults.mode,
    modeSource: mode === 'inline' || mode === 'subagent' ? 'explicit' : 'default',
  };
}
