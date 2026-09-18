/**
 * Local-runtime cron glue — the host-side wiring that adapts the
 * `@mavis/cron` orchestration core onto local-runtime's SQLite store,
 * croner scheduler, agent spawner, and channel delivery stack.
 *
 * `@mavis/cron` owns the orchestration (registry / executor / busy-queue);
 * this folder only injects the host ports it declares.
 */

export {
  createLocalCronRuntime,
  routeLocalCronApi,
  routeLocalAgentCronApi,
  drainQueuedCronPrompts,
  listStoredCronTasks,
  getStoredCronTask,
  createStoredCronTask,
  updateStoredCronTask,
  deleteStoredCronTask,
  type LocalCronRuntime,
  type LocalCronRuntimeOptions,
} from './api.js';
export { SqliteLocalCronStore } from './store.js';
export { buildLocalCronChannelDelivery, type LocalCronChannelDeliveryDeps } from './delivery.js';
