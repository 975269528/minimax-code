/**
 * Classifier subsystem barrel export.
 *
 * Re-exports all public types, constants, and functions from the classifier
 * package for convenient single-import usage.
 */

// dangerous-patterns
export {
  CROSS_PLATFORM_CODE_EXEC,
  DANGEROUS_BASH_PATTERNS,
  DESTRUCTIVE_STANDALONE_COMMANDS,
  HARD_BLOCKED_REGISTRY,
  SOFT_RISK_REGISTRY,
  matchHardBlockedBash,
  matchHardBlockedFsRead,
  isDangerousBashPermission,
} from './dangerous-patterns.js';

export type {
  ClassifierRule,
  ClassifierRuleValue,
  HardBlockedMatch,
  HardBlockedCategory,
  SoftRiskCategory,
} from './dangerous-patterns.js';

// Cloud classify client (endpoint resolution + gating).
export { shouldUseCloudClassify } from './cloud-classify-client.js';
