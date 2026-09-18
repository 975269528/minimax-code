import type { InitializeWorkspaceGitServiceOptions } from './contracts.js';
import { WorkspaceHtmlPreviewService } from './html-preview.service.js';
import { WorkspaceGitService } from './workspace-git.service.js';

function initializeWorkspaceHtmlPreviewService(): WorkspaceHtmlPreviewService {
  return new WorkspaceHtmlPreviewService();
}

function initializeWorkspaceGitService(
  options: InitializeWorkspaceGitServiceOptions = {},
): WorkspaceGitService {
  return new WorkspaceGitService(options);
}

export interface WorkspaceSystem {
  readonly git: WorkspaceGitService;
  readonly htmlPreview: WorkspaceHtmlPreviewService;
}

export function initializeWorkspaceSystem(options: {
  readonly git?: InitializeWorkspaceGitServiceOptions;
}): WorkspaceSystem {
  return {
    git: initializeWorkspaceGitService(options.git),
    htmlPreview: initializeWorkspaceHtmlPreviewService(),
  };
}
