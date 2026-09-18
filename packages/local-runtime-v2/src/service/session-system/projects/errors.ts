export type ProjectFailureReason =
  | 'invalid-project-id'
  | 'project-required'
  | 'invalid-workspace-dir'
  | 'project-not-found'
  | 'duplicate-project'
  | 'invalid-project-row'
  | 'session-cursor-missing';

export class ProjectServiceError extends Error {
  constructor(
    readonly reason: ProjectFailureReason,
    message: string,
  ) {
    super(message);
    this.name = 'ProjectServiceError';
  }
}
