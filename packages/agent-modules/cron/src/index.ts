/**
 * Cron orchestration subsystem — moved from daemon/src/cron in
 * Phase 1.5 of the agent-core extraction.
 *
 * Hosts must call `configureCronHost(...)` once at startup to wire
 * concrete `CronStorePort`, `SessionLifecyclePort`, `AgentSpawnerPort`,
 * and the optional `ChannelDeliveryPort` / `MessageQueuePort` before
 * `CronRegistry.start()` runs. Cross-cutting helpers (`logger`,
 * `nowMs`, etc.) flow through `configureCronHost`.
 */

export {
  CronRegistry,
  type CronRegistryOptions,
  type CronRegistryStartOptions,
  type CronSchedulerPort,
  type CronJobPort,
  type CronMutationSource,
  type CronTriggerSource,
  type CronDeliveryTarget,
  type CronMutationMetricsContext,
  type CronTriggerMetricsContext,
} from './registry.js';
export { CronExecutor, type ExecuteResult } from './executor.js';
export { cleanupRetiredCronTasks, type RetiredCronFileStore } from './retired-cleanup.js';
export { BusyQueue, TTL_MS, type QueuedEntry } from './busy-queue.js';
export { getCurrentTime, parseTime, timeToMinutes, isWithinActiveHours } from './active-hours.js';

// Schemas + types (re-exported from daemon/store/types for back-compat)
export {
  ActiveHoursSchema,
  SessionConfigSchema,
  StoredSessionConfigSchema,
  CronConfigSchema,
  CronFrontmatterSchema,
  DeliveryConfigSchema,
  normalizeSessionConfig,
  resolveReportToRoot,
  type CronConfig,
  type CronFrontmatter,
  type CronConfigUpdate,
  type SessionConfig,
  type ActiveHoursConfig,
  type DeliveryConfig,
  type CronExecutionStatus,
  type CronTaskState,
  type CronTaskResponse,
} from './types.js';

// Host port + registry surface (consumed by daemon Container.initRuntime)
export {
  configureCronHost,
  getMetricsReporter,
  resetCronHostForTesting,
  type CronHostUtils,
  type MetricsReporter,
} from './host-utils.js';

export {
  CRON_MESSAGE_LANE,
  CronSessionType,
  Role,
  type CronStorePort,
  type CronSessionRecord,
  type CronLoadResult,
  type SessionLifecyclePort,
  type AgentSpawnerPort,
  type ChannelDeliveryPort,
  type CronChannelBinding,
  type CronEventBusPort,
  type CronSessionBridgePort,
  type CronAgentResponseHandler,
  type CronSendMessageRequest,
  type CronChannelRunner,
  type MessageQueuePort,
  type CronSessionInfo,
  type CronSessionStatus,
  type AgentMessage,
  type MessageOrigin,
  type MessageSource,
} from './host-ports.js';

export { IM_AUTO_DELIVERY_PROMPT_NOTE } from './report-delivery.js';
