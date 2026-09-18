export type CronRepositoryErrorCode =
  | 'CRON_INVALID'
  | 'CRON_NOT_FOUND'
  | 'CRON_CONFLICT'
  | 'CRON_REVISION_CONFLICT'
  | 'CRON_INVALID_STATE';

export class CronRepositoryError extends Error {
  override readonly name = 'CronRepositoryError';

  constructor(
    readonly code: CronRepositoryErrorCode,
    message: string,
  ) {
    super(message);
  }
}
