/**
 * Tool-level permission checkers barrel export.
 */

import type { PermissionEngine } from '../engine.js';
import { BashToolPermissionChecker } from './bash-checker.js';
import { FsToolPermissionChecker } from './fs-checker.js';

/**
 * Register the built-in tool permission checkers with an engine.
 *
 * Call once at daemon startup, after constructing the engine.
 */
export function registerDefaultCheckers(engine: PermissionEngine): void {
  const bashChecker = new BashToolPermissionChecker();
  const fsChecker = new FsToolPermissionChecker();

  engine.registerToolPermissionChecker('bash', bashChecker);
  engine.registerToolPermissionChecker('edit', fsChecker);
  engine.registerToolPermissionChecker('write', fsChecker);
  engine.registerToolPermissionChecker('append', fsChecker);
  engine.registerToolPermissionChecker('read', fsChecker);
  engine.registerToolPermissionChecker('glob', fsChecker);
  engine.registerToolPermissionChecker('grep', fsChecker);
  engine.registerToolPermissionChecker('list', fsChecker);
}

export { BashToolPermissionChecker } from './bash-checker.js';
export { FsToolPermissionChecker } from './fs-checker.js';

export {
  splitCommand,
  parseShellRule,
  matchShellRule,
  matchWildcardPattern,
  checkBashPermission,
  bashCommandIsSafe,
  isRmCommand,
  parseRmTargets,
  parseRmTargetsWithMetadata,
  buildTrashCommand,
} from './bash-permission.js';

export {
  validatePath,
  containsVulnerableUncPath,
  containsPathTraversal,
  validateGlobPattern,
  isDangerousFile,
  isInDangerousDirectory,
  isDangerousRemovalPath,
  isPublicKeyFile,
  isSensitiveGitFile,
  pathInWorkingPath,
  pathInAllowedWorkingPath,
  isInternalWhitelistedPath,
  isPathAllowed,
  DANGEROUS_FILES,
  DANGEROUS_DIRECTORIES,
} from './fs-permission.js';

export type { PathPermissionResult } from './fs-permission.js';
