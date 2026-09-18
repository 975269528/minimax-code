import {
  closeSync,
  createReadStream,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { createInterface } from 'node:readline';
import type { ObservabilityPrivacyClass, ObservabilityUploadDefault } from './types.js';

export interface DiagnosticBundleLimits {
  maxFiles: number;
  maxBytes: number;
}

export interface DiagnosticArtifact {
  name: string;
  path?: string;
  content?: Buffer | string;
  bytes: number;
  source: string;
  privacy: ObservabilityPrivacyClass;
  uploadDefault: ObservabilityUploadDefault;
}

export interface DiagnosticSourceDescription {
  label: string;
  privacy: ObservabilityPrivacyClass;
  uploadDefault: ObservabilityUploadDefault;
}

export interface DiagnosticArtifactSource {
  id: string;
  describe(): DiagnosticSourceDescription;
  collect(input: DiagnosticArtifactCollectInput): Promise<DiagnosticArtifact[]>;
}

export interface DiagnosticArtifactCollectInput {
  sinceMs: number;
  nowMs: number;
  limits: DiagnosticBundleLimits;
}

export interface DiagnosticBundleManifestSource {
  id: string;
  label: string;
  privacy: ObservabilityPrivacyClass;
  uploadDefault: ObservabilityUploadDefault;
  fileCount: number;
  bytes: number;
  skipped?: string;
}

export interface DiagnosticBundleManifest {
  schemaVersion: 1;
  generatedAtMs: number;
  sinceMs: number;
  sources: DiagnosticBundleManifestSource[];
  artifacts: DiagnosticBundleManifestArtifact[];
  limits: DiagnosticBundleLimits;
  totalFiles: number;
  totalBytes: number;
  skippedArtifacts?: Array<{ name: string; reason: string }>;
}

export interface DiagnosticBundleManifestArtifact {
  name: string;
  source: string;
  bytes: number;
  privacy: ObservabilityPrivacyClass;
  uploadDefault: ObservabilityUploadDefault;
}

export interface DiagnosticBundleResult {
  artifacts: DiagnosticArtifact[];
  manifest: DiagnosticBundleManifest;
}

export interface FileDiagnosticArtifactSourceOptions {
  id: string;
  label: string;
  dir: string;
  match: (fileName: string, relativeName?: string) => boolean;
  prefix: string;
  recursive?: boolean;
  privacy?: ObservabilityPrivacyClass;
  uploadDefault?: ObservabilityUploadDefault;
  maxBytesPerFile?: number;
  errorContext?: ErrorContextConfig;
}

export interface ErrorContextConfig {
  contextLines: number;
  maxOutputBytes: number;
  fallbackRecentMs: number;
  fallbackTailBytes: number;
  errorRegex?: RegExp;
}

const DEFAULT_ERROR_LEVEL_REGEX = /^(?:ERROR|WARN|FATAL)(?:\s|$)/;

/**
 * CSI escape sequences (SGR colors, cursor movement). Log files written
 * before the disk arm started stripping ANSI (see
 * `@mavis/shared/logging/structured-logger.ts`) carry colorized level
 * tokens like `\x1b[31mERROR\x1b[39m` that no plain-text `errorRegex` can
 * match; scanning the stripped line keeps those historical files eligible
 * for error-context extraction during their remaining retention window.
 */
// eslint-disable-next-line no-control-regex -- matching the ESC byte is the point.
const ANSI_CSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

function stripAnsi(line: string): string {
  return line.includes('\u001b') ? line.replace(ANSI_CSI_PATTERN, '') : line;
}

export class FileDiagnosticArtifactSource implements DiagnosticArtifactSource {
  readonly id: string;
  private readonly label: string;
  private readonly dir: string;
  private readonly match: (fileName: string, relativeName?: string) => boolean;
  private readonly prefix: string;
  private readonly recursive: boolean;
  private readonly privacy: ObservabilityPrivacyClass;
  private readonly uploadDefault: ObservabilityUploadDefault;
  private readonly maxBytesPerFile: number | undefined;
  private readonly errorContext: ErrorContextConfig | undefined;

  constructor(options: FileDiagnosticArtifactSourceOptions) {
    this.id = options.id;
    this.label = options.label;
    this.dir = options.dir;
    this.match = options.match;
    this.prefix = options.prefix;
    this.recursive = options.recursive ?? false;
    this.privacy = options.privacy ?? 'sensitive';
    this.uploadDefault = options.uploadDefault ?? 'consent-required';
    this.maxBytesPerFile = options.maxBytesPerFile;
    this.errorContext = options.errorContext;
  }

  describe(): DiagnosticSourceDescription {
    return {
      label: this.label,
      privacy: this.privacy,
      uploadDefault: this.uploadDefault,
    };
  }

  async collect(input: DiagnosticArtifactCollectInput): Promise<DiagnosticArtifact[]> {
    let entries: Array<{ relativeName: string; absolutePath: string }>;
    let dirRealPath: string;
    try {
      dirRealPath = realpathSync(this.dir);
      entries = this.recursive
        ? listRecursiveFiles(this.dir, this.match)
        : readdirSync(this.dir)
            .filter((name) => this.match(name, name))
            .sort()
            .map((name) => ({ relativeName: name, absolutePath: join(this.dir, name) }));
    } catch {
      return [];
    }

    const artifacts: DiagnosticArtifact[] = [];
    for (const entry of entries) {
      const path = entry.absolutePath;
      let stat;
      try {
        stat = lstatSync(path);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      if (!stat.isFile() || stat.mtimeMs < input.sinceMs) continue;
      let realPath: string;
      try {
        realPath = realpathSync(path);
      } catch {
        continue;
      }
      if (!isPathInside(dirRealPath, realPath)) continue;
      if (this.errorContext) {
        let content: string | null;
        try {
          content = await extractErrorContext(path, stat.mtimeMs, input.nowMs, this.errorContext);
        } catch {
          continue;
        }
        if (!content) continue;
        artifacts.push(this.artifact(entry.relativeName, Buffer.from(content, 'utf-8')));
        continue;
      }
      if (this.maxBytesPerFile && stat.size > this.maxBytesPerFile) {
        try {
          artifacts.push(this.artifact(entry.relativeName, tailFile(path, this.maxBytesPerFile)));
        } catch {
          continue;
        }
      } else {
        artifacts.push({
          name: `${this.prefix}${entry.relativeName.replaceAll('\\', '/')}`,
          path,
          bytes: stat.size,
          source: this.id,
          privacy: this.privacy,
          uploadDefault: this.uploadDefault,
        });
      }
    }
    return artifacts;
  }

  private artifact(fileName: string, content: Buffer): DiagnosticArtifact {
    return {
      name: `${this.prefix}${fileName.replaceAll('\\', '/')}`,
      content,
      bytes: content.byteLength,
      source: this.id,
      privacy: this.privacy,
      uploadDefault: this.uploadDefault,
    };
  }
}

function listRecursiveFiles(
  root: string,
  match: (fileName: string, relativeName?: string) => boolean,
): Array<{ relativeName: string; absolutePath: string }> {
  const results: Array<{ relativeName: string; absolutePath: string }> = [];
  const visit = (dir: string, relativeDir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const absolutePath = join(dir, name);
      const relativeName = relativeDir ? `${relativeDir}/${name}` : name;
      let info;
      try {
        info = lstatSync(absolutePath);
      } catch {
        continue;
      }
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        visit(absolutePath, relativeName);
        continue;
      }
      if (!info.isFile() || !match(name, relativeName)) continue;
      results.push({ relativeName, absolutePath });
    }
  };
  const rootStat = statSync(root);
  if (!rootStat.isDirectory()) return [];
  visit(root, '');
  return results;
}

export class StaticDiagnosticArtifactSource implements DiagnosticArtifactSource {
  readonly id: string;
  private readonly label: string;
  private readonly artifacts: DiagnosticArtifact[];

  constructor(id: string, label: string, artifacts: DiagnosticArtifact[]) {
    this.id = id;
    this.label = label;
    this.artifacts = artifacts;
  }

  describe(): DiagnosticSourceDescription {
    const strongestPrivacy = this.artifacts.some((artifact) => artifact.privacy === 'sensitive')
      ? 'sensitive'
      : this.artifacts.some((artifact) => artifact.privacy === 'masked')
        ? 'masked'
        : 'safe';
    const uploadDefault = this.artifacts.some(
      (artifact) => artifact.uploadDefault === 'consent-required',
    )
      ? 'consent-required'
      : this.artifacts.some((artifact) => artifact.uploadDefault === 'exclude')
        ? 'exclude'
        : 'include';
    return { label: this.label, privacy: strongestPrivacy, uploadDefault };
  }

  async collect(): Promise<DiagnosticArtifact[]> {
    return this.artifacts;
  }
}

export async function collectDiagnosticBundle(input: {
  sources: DiagnosticArtifactSource[];
  sinceMs: number;
  nowMs?: number;
  limits?: Partial<DiagnosticBundleLimits>;
}): Promise<DiagnosticBundleResult> {
  const limits = {
    maxFiles: input.limits?.maxFiles ?? 256,
    maxBytes: input.limits?.maxBytes ?? 512 * 1024 * 1024,
  };
  const nowMs = input.nowMs ?? Date.now();
  const artifacts: DiagnosticArtifact[] = [];
  const manifestSources: DiagnosticBundleManifestSource[] = [];
  let totalBytes = 0;
  const skippedArtifacts: Array<{ name: string; reason: string }> = [];

  for (const source of input.sources) {
    const description = source.describe();
    let collected: DiagnosticArtifact[] = [];
    let skipped: string | undefined;
    try {
      collected = await source.collect({ sinceMs: input.sinceMs, nowMs, limits });
    } catch (err) {
      skipped = err instanceof Error ? err.message : String(err);
      collected = [];
    }

    const accepted: DiagnosticArtifact[] = [];
    for (const artifact of collected) {
      if (artifacts.length + accepted.length + 1 > limits.maxFiles) {
        skipped = 'diagnostic_bundle_too_many_files';
        break;
      }
      if (totalBytes + artifact.bytes > limits.maxBytes) {
        skipped = 'diagnostic_bundle_too_large';
        skippedArtifacts.push({ name: artifact.name, reason: skipped });
        continue;
      }
      accepted.push(artifact);
      totalBytes += artifact.bytes;
    }
    artifacts.push(...accepted);
    manifestSources.push({
      id: source.id,
      label: description.label,
      privacy: description.privacy,
      uploadDefault: description.uploadDefault,
      fileCount: accepted.length,
      bytes: accepted.reduce((sum, artifact) => sum + artifact.bytes, 0),
      ...(skipped ? { skipped } : {}),
    });
  }

  return {
    artifacts,
    manifest: {
      schemaVersion: 1,
      generatedAtMs: nowMs,
      sinceMs: input.sinceMs,
      sources: manifestSources,
      artifacts: artifacts.map((artifact) => ({
        name: artifact.name,
        source: artifact.source,
        bytes: artifact.bytes,
        privacy: artifact.privacy,
        uploadDefault: artifact.uploadDefault,
      })),
      limits,
      totalFiles: artifacts.length,
      totalBytes,
      ...(skippedArtifacts.length > 0 ? { skippedArtifacts } : {}),
    },
  };
}

function isPathInside(root: string, child: string): boolean {
  const rel = relative(root, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}

function tailFile(path: string, maxBytes: number): Buffer {
  const fd = openSync(path, 'r');
  try {
    const { size } = fstatSync(fd);
    const readBytes = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(readBytes);
    readSync(fd, buffer, 0, readBytes, Math.max(0, size - readBytes));
    if (size <= maxBytes) return buffer;
    const marker = Buffer.from('\n... [truncated to tail] ...\n', 'utf-8');
    return Buffer.concat([marker, buffer]);
  } finally {
    closeSync(fd);
  }
}

async function extractErrorContext(
  path: string,
  mtimeMs: number,
  nowMs: number,
  config: ErrorContextConfig,
): Promise<string | null> {
  const errorRegex = config.errorRegex ?? DEFAULT_ERROR_LEVEL_REGEX;
  const stream = createReadStream(path, { encoding: 'utf-8' });
  const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  const before: Array<{ index: number; line: string }> = [];
  const output: string[] = [];
  let bytes = 0;
  let lineIndex = 0;
  let lastEmittedIndex = -1;
  let afterUntil = -1;
  let hitCount = 0;
  let truncated = false;

  const emitLine = (index: number, line: string): boolean => {
    if (index <= lastEmittedIndex) return true;
    if (lastEmittedIndex >= 0 && index > lastEmittedIndex + 1) {
      output.push('... [context skipped] ...');
    }
    bytes += Buffer.byteLength(line, 'utf-8') + 1;
    if (bytes > config.maxOutputBytes) {
      output.push('... [truncated] ...');
      truncated = true;
      return false;
    }
    output.push(line);
    lastEmittedIndex = index;
    return true;
  };

  try {
    for await (const rawLine of rl) {
      // Match and emit the ANSI-stripped line: historical colorized files
      // stay scannable and the extracted context reads as plain text.
      const line = stripAnsi(rawLine);
      const isHit = errorRegex.test(line);
      if (isHit) {
        hitCount += 1;
        for (const entry of before) {
          if (!emitLine(entry.index, entry.line)) break;
        }
        if (!truncated) emitLine(lineIndex, line);
        afterUntil = Math.max(afterUntil, lineIndex + config.contextLines);
      } else if (lineIndex <= afterUntil) {
        emitLine(lineIndex, line);
      }
      if (truncated) break;
      before.push({ index: lineIndex, line });
      while (before.length > config.contextLines) before.shift();
      lineIndex += 1;
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  if (hitCount === 0) {
    if (nowMs - mtimeMs > config.fallbackRecentMs) return null;
    return tailFile(path, config.fallbackTailBytes).toString('utf-8');
  }
  return output.join('\n');
}
