/**
 * LocalWebsiteDeployTool: Local implementation of `website_deploy`.
 *
 * Shares the cloud `CloudWebsiteDeployTool` name but differs in semantics: cloud holds OSS AK/SK
 * in-process and uploads individual files directly; local **holds no OSS credentials**, validates
 * local fs, and delegates packaging + upload + publication to `LocalWebsiteDeployAdapter` (injected
 * by local-runtime, using backend presigned upload + unpacking/publication; see draft design option
 * B).
 *
 * Keep def + impl together, matching cloud's one-tool-per-file convention in
 * `cloud-website-deploy.ts`. Do **not** put it in `builtin-defs.ts`, which holds only basic Pi tool
 * definitions and would create a cycle with this file / types.ts.
 *
 * Key description contracts affecting LLM call decisions:
 * 1. User confirmation is required before public publication. This tool publishes to a **publicly
 *   accessible URL**; the local permission ask gate enforces this, while the description only
 *   guides the LLM.
 * 2. Input must be an **already-built static site directory** (production dist/ containing
 *   index.html), not source code. Missing index.html fails local prechecks without calling the
 *   adapter / backend.
 * 3. Before calling, use `ask_user` to let the user choose between updating the existing site and
 *   publishing a new one. Consequences differ and are hard to undo: nodeId replaces all online
 *   content while retaining URL/alias; omitting it creates a drive node and new URL. This
 *   distinction exists only in the description, not the permission gate, so the model must ask
 *   first.
 *
 * Failure observability: This layer (agent-tools/desktop) owns no logger and calls no console
 * methods. local-runtime's `LocalWebsiteDeployClient` emits structured `website deploy stage`
 * events (stage/result/status_code/error_code/status_msg_present). `status_msg_present:false`
 * corresponds to the neutral fallback used here when the backend supplies no usable message,
 * allowing logs to identify the selected failure wording.
 *
 * Failure semantics (same as cloud): All failures return `ToolResult` with `details.ok=false` and
 * human/LLM-readable text; **never throw**. pi-agent would turn thrown errors into an unhelpful
 * "Tool execution error", hindering self-correction. Already-aborted signals also return readable
 * failures.
 */

import { Type, type Static } from '@sinclair/typebox';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import {
  bindTool,
  type ToolDefinition,
  type ToolImpl,
  type ToolResult,
} from '@mavis/agent-core/tools';

import { resolveWithinWorkspace } from './path-guard.js';
import type {
  LocalRuntimeToolContext,
  LocalWebsiteDeployAdapter,
  LocalWebsiteDeployAdapterFailure,
  LocalWebsiteDeployFailureReason,
  LocalWebsiteDeployStage,
} from './types.js';

const LOCAL_WEBSITE_DEPLOY_FAILURE_REASONS = new Set<string>([
  'aborted',
  'validation_failed',
  'packaging_failed',
  'upload_url_rejected',
  'transport_failed',
  'service_request_failed',
  'publish_contract_failed',
  'adapter_failed',
]);

const LOCAL_WEBSITE_DEPLOY_STAGES = new Set<string>([
  'adapter',
  'validate_site',
  'upload_site',
  'validate_source',
  'upload_source',
  'get_upload_url',
  'get_upload_url_source',
  'upload_archive',
  'upload_source_archive',
  'publish_archive',
  'update_archive',
]);

type LocalSourcePathValidationReason =
  | 'missing_source_path'
  | 'invalid_source_path'
  | 'source_path_escape'
  | 'source_not_found'
  | 'source_stat_failed'
  | 'source_not_a_directory'
  | 'source_realpath_failed'
  | 'source_inside_build';

export const LocalWebsiteDeployToolDef = {
  name: 'website_deploy',
  // Public writes have side effects: keep execution sequential, matching local `write`.
  // Do not mark parallel, avoiding a different execution/permission path from read-only tools such as web_fetch.
  executionMode: 'sequential',
  description:
    '⚠️ **Public deployment — user confirmation required.** This publishes files from THIS ' +
    'machine to a **publicly-accessible URL on the open Internet**. Anyone with the link can ' +
    'view the deployed site. Before invoking you MUST: (1) tell the user the site will be ' +
    'public, (2) get explicit confirmation. The local permission gate also gates this tool, but ' +
    'do not rely on it alone — confirm at the moment of publishing. `source_path` is required ' +
    'and source code is always uploaded to private cloud storage, so tell the user about this ' +
    'source upload when confirming publication; the initial release has no secrets scanner and ' +
    'only applies the `.env*` and other documented exclusion rules.\n\n' +
    'Deploy a **built static website** (a directory containing index.html and bundled assets — ' +
    'e.g. the output of `vite build` / `next export` / similar bundler dist/) to a public URL. ' +
    'The directory **must contain index.html at the root**. **Do not pass source code or ' +
    'unbuilt project directories** — run the build step first and pass the dist/ output. The ' +
    'site is registered as a node in the user drive (category=website). Returns the public URL. ' +
    'Omit `node_id` for a first publish. To update an existing site in place, pass the exact ' +
    'string `node_id` returned by the prior deployment; its original primary and alias URLs stay ' +
    'attached to that node.\n\n' +
    '⚠️ **Pick in-place update vs new site with the user before calling.** Whenever this publish ' +
    'could target a site that already exists — the user says "update / change that site", an ' +
    'earlier deployment in this context returned a `node_id`, or their drive already holds a site ' +
    'with the same name — you MUST ask via `ask_user` first and have the user choose explicitly ' +
    'between: (a) **update the existing site in place** — pass `node_id`, the original primary and ' +
    'alias URLs are kept, and the live site content is **replaced wholesale** by this upload; or ' +
    '(b) **publish as a new site** — omit `node_id`, which creates a new drive node with a ' +
    '**brand-new URL** and leaves the existing site untouched. The two outcomes are asymmetric ' +
    'and not easily undone: (a) overwrites what is already public, (b) leaves the user a second ' +
    'site to manage separately. Do not guess: never decide to pass or omit `node_id` on your own ' +
    'while the user has made no explicit choice.\n\n' +
    'When delivering the deployed site to the user, output it inside a <deliver-assets> block ' +
    'with type="website":\n\n' +
    '<deliver-assets>\n' +
    '<media type="website" src="<the deployed URL returned in tool result>" node_id="<the node ID returned in tool result>" name="<project_name>" />\n' +
    '</deliver-assets>',
  schema: Type.Object({
    node_id: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          'Optional exact string ID of an existing website drive node. Omit for a first publish. ' +
          'Pass it only after the user has explicitly chosen to update that existing site in ' +
          'place — doing so replaces the live site content wholesale while keeping its URLs. ' +
          'When present, website_deploy updates that node in place; never convert node IDs to numbers.',
      }),
    ),
    path: Type.String({
      description:
        'Workspace-relative or absolute path to the **built** static-site root directory ' +
        '(bundler dist/ output). Must contain index.html.',
    }),
    project_name: Type.String({
      description:
        'Used as the display name of the drive node and the HTML <title> tag when missing from ' +
        'the source. Pick a short human-readable name.',
    }),
    source_path: Type.String({
      description:
        'Required workspace-relative or absolute path to the project source root. It is always ' +
        'uploaded to private cloud storage separately from the public built site; do not include ' +
        'secrets. It must be a real directory. A self-contained static site may use the same ' +
        'directory as path. If the build path is inside it, the build directory is excluded from ' +
        'the source archive. A source path inside the build path is rejected.',
    }),
  }),
} as const satisfies ToolDefinition;

export type LocalWebsiteDeployToolInput = Static<typeof LocalWebsiteDeployToolDef.schema>;

@bindTool(LocalWebsiteDeployToolDef)
export class LocalWebsiteDeployTool implements ToolImpl<
  typeof LocalWebsiteDeployToolDef.schema,
  LocalRuntimeToolContext
> {
  constructor(
    private readonly adapter: LocalWebsiteDeployAdapter,
    private readonly workspaceRoot: string,
  ) {}

  async execute(
    ctx: LocalRuntimeToolContext,
    input: LocalWebsiteDeployToolInput,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (signal?.aborted) {
      return aiReadableFailure(`Deploy was aborted before it started.`, {
        reason: 'aborted',
        path: input.path,
      });
    }

    // Schema validation can be bypassed by a direct tool call; reject before any fs or adapter work.
    const sourcePath: unknown = input.source_path;
    if (typeof sourcePath !== 'string') {
      return sourcePathValidationFailure(
        'Cannot deploy: source_path is required.',
        'missing_source_path',
      );
    }
    if (!sourcePath.trim()) {
      return sourcePathValidationFailure(
        'Cannot deploy: source_path must not be empty.',
        'invalid_source_path',
        {
          source_path: sourcePath,
        },
      );
    }

    const rawNodeId: unknown = input.node_id;
    let nodeId: string | undefined;
    if (rawNodeId !== undefined) {
      if (typeof rawNodeId !== 'string' || !rawNodeId.trim() || rawNodeId !== rawNodeId.trim()) {
        return aiReadableFailure('Cannot deploy: node_id must be a non-empty exact string.', {
          reason: 'invalid_node_id',
        });
      }
      nodeId = rawNodeId;
    }

    // 1) Validate the path boundary, directory, and required index.html locally, before invoking the adapter.
    let dir: string;
    try {
      dir = await resolveWithinWorkspace(input.path, this.workspaceRoot);
    } catch (err) {
      return aiReadableFailure(
        `Cannot deploy: '${input.path}' is outside the workspace or invalid. ` +
          `Pass a path that lives under the current working directory.`,
        { reason: 'path_escape', path: input.path, detail: describeError(err) },
      );
    }

    let dirStat;
    try {
      // lstat: reject a symlink at the build root; ancestor symlink aliases
      // remain valid because the workspace guard already resolved their target.
      dirStat = await lstat(dir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return aiReadableFailure(
          `Cannot deploy: '${input.path}' does not exist. website_deploy needs a built ` +
            `static site (a bundler dist/ output). Run the build step first, then pass the ` +
            `output directory path.`,
          { reason: 'not_found', path: input.path },
        );
      }
      return aiReadableFailure(
        `Cannot deploy: unable to read '${input.path}'. Check the path and permissions, ` +
          `then retry.`,
        { reason: 'stat_failed', path: input.path, detail: describeError(err) },
      );
    }
    if (!dirStat.isDirectory()) {
      return aiReadableFailure(
        `Cannot deploy: '${input.path}' is not a directory. Pass the path to the built ` +
          `site directory (containing index.html), not a single file.`,
        { reason: 'not_a_directory', path: input.path },
      );
    }

    const indexPath = join(dir, 'index.html');
    let indexStat;
    try {
      // lstat (not stat): do NOT follow symlinks. The runtime packaging
      // (walkDeployableFiles) skips symlink entries, so a symlinked root
      // index.html would pass a stat()-based pre-check yet be absent from
      // the uploaded zip — publishing a site that 404s on `/`. Rejecting it
      // here keeps the pre-check consistent with what actually gets packaged.
      indexStat = await lstat(indexPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return aiReadableFailure(
          `Cannot deploy: '${input.path}' has no index.html at the root. website_deploy needs ` +
            `a built static site (a bundler dist/ output, e.g. from \`vite build\` / ` +
            `\`next export\`), not source code or an unbuilt project. The site won't load ` +
            `without a root index.html — run the build step first and try again.`,
          { reason: 'missing_index_html', path: input.path },
        );
      }
      return aiReadableFailure(
        `Cannot deploy: unable to read '${input.path}/index.html'. Check the file is present ` +
          `and readable, then retry.`,
        { reason: 'index_stat_failed', path: input.path, detail: describeError(err) },
      );
    }
    if (!indexStat.isFile()) {
      return aiReadableFailure(
        `Cannot deploy: '${input.path}/index.html' isn't a regular file (it's a directory or ` +
          `symlink). The deploy packager skips symlinks, so the published site would be missing ` +
          `its root index.html — make sure the build produced a real index.html file.`,
        { reason: 'index_not_a_file', path: input.path },
      );
    }

    let sourceDir: string | undefined;
    if (input.source_path !== undefined) {
      if (!input.source_path.trim()) {
        return sourcePathValidationFailure(
          'Cannot deploy: source_path must not be empty.',
          'invalid_source_path',
          { source_path: input.source_path },
        );
      }
      try {
        sourceDir = await resolveWithinWorkspace(input.source_path, this.workspaceRoot);
      } catch (err) {
        return sourcePathValidationFailure(
          `Cannot deploy: '${input.source_path}' is outside the workspace or invalid. ` +
            `Pass a source path that lives under the current working directory.`,
          'source_path_escape',
          { source_path: input.source_path, detail: describeError(err) },
        );
      }

      let sourceStat;
      try {
        sourceStat = await lstat(sourceDir);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          return sourcePathValidationFailure(
            `Cannot deploy: '${input.source_path}' does not exist.`,
            'source_not_found',
            { source_path: input.source_path },
          );
        }
        return sourcePathValidationFailure(
          `Cannot deploy: unable to read '${input.source_path}'.`,
          'source_stat_failed',
          { source_path: input.source_path, detail: describeError(err) },
        );
      }
      if (!sourceStat.isDirectory()) {
        return sourcePathValidationFailure(
          `Cannot deploy: '${input.source_path}' is not a real directory.`,
          'source_not_a_directory',
          { source_path: input.source_path },
        );
      }

      let canonicalDir: string;
      let canonicalSourceDir: string;
      try {
        [canonicalDir, canonicalSourceDir] = await Promise.all([
          realpath(dir),
          realpath(sourceDir),
        ]);
      } catch (err) {
        return sourcePathValidationFailure(
          'Cannot deploy: unable to resolve the source directory safely.',
          'source_realpath_failed',
          { source_path: input.source_path, detail: describeError(err) },
        );
      }
      if (canonicalDir !== canonicalSourceDir && isPathInside(canonicalDir, canonicalSourceDir)) {
        return sourcePathValidationFailure(
          'Cannot deploy: source_path cannot be nested inside the built site directory.',
          'source_inside_build',
          { source_path: input.source_path },
        );
      }
    }

    // 2) Session anchors publication identity/auditing; absence indicates an internal runtime state problem.
    const sessionId = ctx.sessionId;
    if (!sessionId) {
      return aiReadableFailure(
        `Deploy needs an active session, but the current turn has none. Please report this ` +
          `to the user — it's an internal state issue, not something they can fix.`,
        { reason: 'missing_session_id', path: input.path },
      );
    }

    // 3) Delegate packaging + upload + publication to the adapter; local code handles no OSS credentials.
    let resp;
    try {
      resp = await this.adapter.deploy(
        {
          dir,
          ...(sourceDir ? { sourceDir } : {}),
          ...(nodeId ? { nodeId } : {}),
          projectName: input.project_name,
          sessionId,
          turnId: ctx.turnId,
        },
        signal,
      );
    } catch (err) {
      const failure = asWebsiteDeployAdapterFailure(err);
      const stage = failure?.stage ?? 'adapter';
      const retryable = failure?.retryable ?? false;
      return aiReadableFailure(
        `Deploy failed during ${stage}: ${describeError(err)}.${
          retryable ? ' Retry the same call to try again.' : ''
        }`,
        {
          reason: failure?.reason ?? 'adapter_failed',
          stage,
          retryable,
          detail: describeError(err),
          path: input.path,
        },
      );
    }

    const statusCode = resp.base_resp?.status_code ?? 0;
    if (statusCode !== 0) {
      // The backend's `status_msg` carries the user-facing failure reason. Forward it **unchanged** instead of
      // hardcoding client messages by business code: only the backend knows whether the site was unpublished,
      // content review failed, quota was exhausted, etc. A client code-to-message map would duplicate backend
      // maintenance and inevitably drift. The client only classifies the rejection as a non-retryable business
      // failure and gives the message to the model to relay.
      //
      // Historical defect (2026-08-16, domestic production): This branch unconditionally returned "website deployment is currently
      // unavailable", misreporting business state conflicts such as `UNPUBLISHED` (site unpublished; republish first)
      // as infrastructure failures. Users thought the service was down and missed the required action. Never
      // claim service unavailability here: reasons must come from the backend, with neutral wording if absent.
      const backendMessage =
        typeof resp.base_resp?.status_msg === 'string' && resp.base_resp.status_msg.trim()
          ? resp.base_resp.status_msg
          : undefined;
      const errorCode =
        typeof resp.error_code === 'string' && resp.error_code.trim() ? resp.error_code : undefined;
      // Keep existing details fields and values: without a usable backend message, status_msg still falls back
      // to the same technical description, preserving downstream reason/status_code classification.
      const statusMsg = backendMessage ?? `publish service returned status_code=${statusCode}`;
      const text = backendMessage
        ? `Deploy was rejected by the publish service: ${backendMessage}` +
          `${errorCode ? ` (error_code=${errorCode})` : ''}. Relay this reason to the user as the ` +
          `actual cause and tell them the concrete next step it implies. This is a business-side ` +
          `rejection, so retrying the same call will not succeed until that condition is resolved.`
        : `Deploy was rejected by the publish service, which returned no reason message ` +
          `(status_code=${statusCode}${errorCode ? `, error_code=${errorCode}` : ''}). Tell the ` +
          `user the publish request was rejected and surface this technical detail. This is a ` +
          `business-side rejection, so retrying the same call will not succeed.`;
      return aiReadableFailure(text, {
        reason: 'publish_business_failure',
        stage: nodeId ? 'update_archive' : 'publish_archive',
        retryable: false,
        status_code: statusCode,
        status_msg: statusMsg,
        ...(errorCode ? { error_code: errorCode } : {}),
        path: input.path,
      });
    }

    // 4) Success: Give the model the URL and trusted node ID (if returned); cover_path goes only in details.
    const websiteUrl = resp.cdn_url ?? '';
    if (!websiteUrl) {
      return aiReadableFailure(
        `Deploy returned an empty URL — this is unexpected. Please tell the user the ` +
          `deployment didn't complete cleanly.`,
        {
          reason: 'empty_cdn_url',
          stage: nodeId ? 'update_archive' : 'publish_archive',
          retryable: false,
          path: input.path,
        },
      );
    }
    const summary = [
      `${nodeId ? 'Website updated' : 'Website deployed'}: ${websiteUrl}`,
      ...(resp.node_id ? [`Drive node ID: ${resp.node_id}`] : []),
    ].join('\n');
    return {
      tool_name: LocalWebsiteDeployToolDef.name,
      text: summary,
      content: [{ type: 'text', text: summary }],
      details: {
        ok: true,
        website_url: websiteUrl,
        ...(resp.node_id ? { node_id: resp.node_id } : {}),
        ...(resp.cover_path ? { cover_path: resp.cover_path } : {}),
      },
    };
  }
}

/**
 * Unified AI-readable failure helper: always return ToolResult, never throw. `text` is the
 * LLM-facing body used for self-correction; `details.ok=false` + `reason` enables precise
 * SRE/developer classification.
 */
function aiReadableFailure(message: string, details: Record<string, unknown>): ToolResult {
  return {
    tool_name: LocalWebsiteDeployToolDef.name,
    text: message,
    content: [{ type: 'text', text: message }],
    details: { ok: false, ...details },
  };
}

function sourcePathValidationFailure(
  message: string,
  reason: LocalSourcePathValidationReason,
  details: Record<string, unknown> = {},
): ToolResult {
  const errorCode =
    reason === 'missing_source_path'
      ? 'LOCAL_SOURCE_PATH_REQUIRED'
      : reason === 'source_path_escape'
        ? 'LOCAL_SOURCE_PATH_ESCAPE'
        : 'LOCAL_SOURCE_PATH_INVALID';
  return aiReadableFailure(message, {
    ...details,
    error_code: errorCode,
    reason,
    stage: 'validate_source',
    retryable: false,
  });
}

function describeError(err: unknown): string {
  if (err === null || err === undefined) return 'unknown error';
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === 'string') return err;
  return String(err);
}

function asWebsiteDeployAdapterFailure(err: unknown): LocalWebsiteDeployAdapterFailure | undefined {
  if (!(err instanceof Error)) return undefined;
  const candidate = err as Partial<LocalWebsiteDeployAdapterFailure>;
  return isLocalWebsiteDeployFailureReason(candidate.reason) &&
    isLocalWebsiteDeployStage(candidate.stage) &&
    typeof candidate.retryable === 'boolean'
    ? (candidate as LocalWebsiteDeployAdapterFailure)
    : undefined;
}

function isLocalWebsiteDeployFailureReason(
  value: unknown,
): value is LocalWebsiteDeployFailureReason {
  return typeof value === 'string' && LOCAL_WEBSITE_DEPLOY_FAILURE_REASONS.has(value);
}

function isLocalWebsiteDeployStage(value: unknown): value is LocalWebsiteDeployStage {
  return typeof value === 'string' && LOCAL_WEBSITE_DEPLOY_STAGES.has(value);
}

function isPathInside(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
