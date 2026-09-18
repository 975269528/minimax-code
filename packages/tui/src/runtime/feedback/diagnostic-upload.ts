import { open, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import {
  getRuntimeBuildEnv,
  getRuntimeRegion,
  type MavisBuildEnv,
  type MavisRegion,
} from '@mavis/config';
import JSZip from 'jszip';
import type { SessionReportManifest } from '@mavis/local-runtime-v2/session-system';

import { summarizeDiagnosticText } from './diagnostic-summary.js';

const LOG_WINDOW_MS = 2 * 24 * 60 * 60 * 1_000;
const MAX_FILES = 64;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_BYTES_PER_FILE = 2 * 1024 * 1024;

const LOG_UPLOAD_API_BASE: Readonly<Record<MavisRegion, Readonly<Record<MavisBuildEnv, string>>>> =
  {
    cn: {
      dev: 'https://matrix-test.example.invalid',
      test: 'https://matrix-test.example.invalid',
      staging: 'https://matrix-pre.example.invalid',
      prod: 'https://agent.minimaxi.com',
    },
    en: {
      dev: 'https://matrix-overseas-test.example.invalid',
      test: 'https://matrix-overseas-test.example.invalid',
      staging: 'https://matrix-overseas-pre.example.invalid',
      prod: 'https://agent.minimax.io',
    },
  };

export interface TuiFeedbackDiagnosticInput {
  readonly description: string;
  readonly sessionId?: string;
  readonly signal: AbortSignal;
}

export interface TuiFeedbackDiagnosticOptions {
  readonly dataDir: string;
  readonly appVersion: string;
  readonly fetchImpl?: typeof fetch;
  readonly nowMs?: () => number;
  readonly region?: () => MavisRegion;
  readonly buildEnv?: () => MavisBuildEnv;
  readonly flushLogs?: () => Promise<void>;
  readonly collectSessionReport?: (sessionId: string) => Promise<SessionReportManifest>;
}

interface DiagnosticSource {
  readonly directory: string;
  readonly prefix: string;
  readonly matches: (name: string, relativeName?: string) => boolean;
  readonly recursive?: boolean;
}

interface DiagnosticArtifact {
  readonly name: string;
  readonly sourcePath?: string;
  readonly content?: string;
  readonly modifiedAtMs: number;
  readonly sizeBytes: number;
  readonly required: boolean;
  readonly wholeFile?: boolean;
}

export async function uploadTuiFeedbackDiagnostics(
  input: TuiFeedbackDiagnosticInput,
  options: TuiFeedbackDiagnosticOptions,
): Promise<{ readonly uploadId: string }> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const nowMs = (options.nowMs ?? Date.now)();
  await options.flushLogs?.();
  input.signal.throwIfAborted();
  const skipped: Array<{ readonly name: string; readonly reason: string }> = [];
  let requiredArtifacts: DiagnosticArtifact[] = [];
  try {
    requiredArtifacts = await collectRequiredSessionArtifacts(input, options);
  } catch (error) {
    if (input.signal.aborted) throw error;
    skipped.push({
      name: 'session',
      reason: 'session_report_unavailable',
    });
  }
  const optionalArtifacts = await collectArtifacts(
    options.dataDir,
    nowMs - LOG_WINDOW_MS,
    input.signal,
  );
  const artifacts = [...requiredArtifacts, ...optionalArtifacts];
  const zip = new JSZip();
  let totalBytes = 0;
  let sourceBytes = 0;
  let totalFiles = 0;
  for (const [index, artifact] of artifacts.entries()) {
    // Opaque archive names prevent source paths, session IDs and attachment names leaking.
    const category = artifact.required ? 'session' : artifact.name.split('/')[0];
    const name = `${category}/artifact-${index + 1}.json`;
    // Bound source reads independently of the much smaller summary output.
    const readBytes = artifact.required
      ? artifact.sizeBytes
      : Math.min(artifact.sizeBytes, MAX_BYTES_PER_FILE);
    if (sourceBytes + readBytes > MAX_BYTES) {
      skipped.push({ name, reason: 'diagnostic_bundle_too_large' });
      continue;
    }
    sourceBytes += readBytes;
    let content: string;
    try {
      content = await readDiagnosticText(artifact, input.signal);
    } catch (error) {
      if (input.signal.aborted) throw error;
      skipped.push({ name, reason: 'read_failed' });
      continue;
    }
    const uploadContent = Buffer.from(summarizeDiagnosticText(content, artifact.name), 'utf8');
    if (totalBytes + uploadContent.byteLength > MAX_BYTES) {
      skipped.push({ name, reason: 'diagnostic_bundle_too_large' });
      continue;
    }
    totalBytes += uploadContent.byteLength;
    zip.file(name, uploadContent);
    totalFiles += 1;
  }
  zip.file(
    'diagnostic-manifest.json',
    JSON.stringify(
      {
        schemaVersion: 2,
        redactionPolicy: 'diagnostic-counts-v1',
        contentOmitted: true,
        createdAtMs: nowMs,
        totalFiles,
        totalBytes,
        context: {
          clientVersion: /^\d{1,5}\.\d{1,5}\.\d{1,5}$/u.test(options.appVersion)
            ? options.appVersion
            : 'unknown',
        },
        skipped,
      },
      null,
      2,
    ),
  );
  const archive = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });
  input.signal.throwIfAborted();
  const region = (options.region ?? getRuntimeRegion)();
  const buildEnv = (options.buildEnv ?? getRuntimeBuildEnv)();
  const baseUrl = LOG_UPLOAD_API_BASE[region][buildEnv];
  const presignResponse = await fetchImpl(`${baseUrl}/matrix/api/v1/log/upload`, {
    method: 'POST',
    headers: {
      'User-Agent': 'MiniMaxAgent',
      Origin: baseUrl,
      Referer: `${baseUrl}/`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      device_id: '0',
      base_file_name: `mcode-feedback-${archiveTimestamp(nowMs)}.zip`,
    }),
    signal: input.signal,
  });
  if (!presignResponse.ok) {
    throw new Error(`Feedback diagnostic presign failed with HTTP ${presignResponse.status}.`);
  }
  const presign = await readJsonRecord(presignResponse);
  const uploadId = readUploadId(presign.upload_id ?? presign.uploadId);
  const uploadUrl = readHttpsUrl(presign.upload_url ?? presign.uploadUrl);
  if (!uploadId || !uploadUrl) {
    throw new Error('Feedback diagnostic upload returned an invalid upload receipt.');
  }
  const uploadResponse = await fetchImpl(uploadUrl, {
    method: 'PUT',
    body: new Uint8Array(archive),
    signal: input.signal,
  });
  if (!uploadResponse.ok) {
    throw new Error(`Feedback diagnostic upload failed with HTTP ${uploadResponse.status}.`);
  }
  return { uploadId };
}

async function collectArtifacts(
  dataDir: string,
  cutoffMs: number,
  signal: AbortSignal,
): Promise<DiagnosticArtifact[]> {
  const v2ObservabilityRoot = join(dataDir, 'v2', 'observability');
  const v2LogsDir = join(v2ObservabilityRoot, 'logs');
  const sources: DiagnosticSource[] = [
    {
      directory: v2LogsDir,
      prefix: 'runtime/',
      matches: (name) =>
        /^(?:local-runtime|runtime|im-runtime)-.*\.log$/u.test(name) ||
        /^local-proxy-.*\.jsonl$/u.test(name),
      recursive: true,
    },
    {
      directory: join(v2ObservabilityRoot, 'mcode'),
      prefix: 'mcode/',
      matches: (name) => /^mcode-observability-.*\.jsonl$/u.test(name),
    },
    {
      directory: join(v2ObservabilityRoot, 'events'),
      prefix: 'runtime-events/',
      matches: (name) => /^runtime-events-\d{4}-\d{2}-\d{2}(?:\.\d+)?\.jsonl$/u.test(name),
      recursive: true,
    },
    {
      directory: join(dataDir, 'logs'),
      prefix: 'cli/',
      matches: (name) => name === 'cli.log' || /^tui-terminal-.*\.log$/u.test(name),
    },
    {
      directory: join(v2ObservabilityRoot, 'cli', 'incidents'),
      prefix: 'cli/incidents/',
      matches: (name) => name.endsWith('.json'),
    },
  ];
  const artifacts: DiagnosticArtifact[] = [];
  for (const source of sources) {
    signal.throwIfAborted();
    await collectSourceArtifacts(source, source.directory, '', cutoffMs, signal, artifacts);
  }
  return artifacts
    .sort(
      (left, right) =>
        right.modifiedAtMs - left.modifiedAtMs || left.name.localeCompare(right.name),
    )
    .slice(0, MAX_FILES);
}

async function collectSourceArtifacts(
  source: DiagnosticSource,
  directory: string,
  relativeDirectory: string,
  cutoffMs: number,
  signal: AbortSignal,
  artifacts: DiagnosticArtifact[],
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    signal.throwIfAborted();
    const relativeName = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    const sourcePath = join(directory, entry.name);
    if (entry.isDirectory() && source.recursive) {
      await collectSourceArtifacts(source, sourcePath, relativeName, cutoffMs, signal, artifacts);
      continue;
    }
    if (!entry.isFile() || !source.matches(entry.name, relativeName)) continue;
    let info;
    try {
      info = await stat(sourcePath);
    } catch (error) {
      if (signal.aborted) throw error;
      continue;
    }
    if (!info.isFile() || info.mtimeMs < cutoffMs) continue;
    artifacts.push({
      name: `${source.prefix}${relativeName}`,
      sourcePath,
      modifiedAtMs: info.mtimeMs,
      sizeBytes: info.size,
      required: false,
      wholeFile: nameIsSingleJson(entry.name),
    });
  }
}

async function readDiagnosticText(
  artifact: DiagnosticArtifact,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  if (artifact.content !== undefined) return artifact.content;
  if (!artifact.sourcePath) throw new Error(`Diagnostic artifact has no source: ${artifact.name}`);
  if (artifact.required) return readFile(artifact.sourcePath, 'utf8');
  if (artifact.wholeFile && artifact.sizeBytes > MAX_BYTES_PER_FILE) {
    throw new Error('diagnostic_single_json_too_large');
  }
  const bytes = Math.min(artifact.sizeBytes, MAX_BYTES_PER_FILE);
  const truncated = artifact.sizeBytes > bytes;
  const buffer = Buffer.alloc(bytes);
  const handle = await open(artifact.sourcePath, 'r');
  try {
    const result = await handle.read(buffer, 0, bytes, Math.max(0, artifact.sizeBytes - bytes));
    signal.throwIfAborted();
    const text = buffer.subarray(0, result.bytesRead).toString('utf8');
    if (!truncated) return text;
    const firstNewline = text.indexOf('\n');
    return firstNewline >= 0 ? text.slice(firstNewline + 1) : text;
  } finally {
    await handle.close();
  }
}

async function collectRequiredSessionArtifacts(
  input: TuiFeedbackDiagnosticInput,
  options: TuiFeedbackDiagnosticOptions,
): Promise<DiagnosticArtifact[]> {
  if (!input.sessionId) return [];
  if (!options.collectSessionReport) {
    throw new Error('session_report_capability_unavailable');
  }
  const report = await options.collectSessionReport(input.sessionId);
  return report.artifacts.map((artifact) => ({
    name: artifact.name,
    ...(artifact.path ? { sourcePath: artifact.path } : {}),
    ...(artifact.content !== undefined ? { content: artifact.content } : {}),
    modifiedAtMs: 0,
    sizeBytes: artifact.bytes,
    required: true,
    wholeFile: nameIsSingleJson(artifact.name),
  }));
}

function nameIsSingleJson(name: string): boolean {
  return name.endsWith('.json') && !name.endsWith('.jsonl');
}

async function readJsonRecord(response: Response): Promise<Record<string, unknown>> {
  try {
    const value = JSON.parse(await response.text()) as unknown;
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function readUploadId(value: unknown): string | undefined {
  if (typeof value === 'number')
    return Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readHttpsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function archiveTimestamp(epochMs: number): string {
  const date = new Date(epochMs);
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
    String(date.getUTCHours()).padStart(2, '0'),
    String(date.getUTCMinutes()).padStart(2, '0'),
    String(date.getUTCSeconds()).padStart(2, '0'),
  ].join('');
}
