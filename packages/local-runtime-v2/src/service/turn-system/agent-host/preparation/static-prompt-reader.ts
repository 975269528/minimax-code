import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isAgentBuiltinToolEnabled,
  resolveAgentCapabilities,
  type ResolvedAgentCapabilities,
} from '@mavis/config';

const LEGACY_AGENT_INSTRUCTIONS_FILE = '\x43\x4c\x41\x55\x44\x45.md';
const PROJECT_INSTRUCTIONS_MAX_BYTES = 32 * 1024;
const GLOBAL_INSTRUCTIONS_MAX_BYTES = 32 * 1024;

interface StaticPromptReaderLogger {
  warn(fields: Readonly<Record<string, unknown>>, message: string): void;
}

interface GlobalInstructionsPromptReader {
  readForPrompt(): Promise<string | undefined>;
}

export interface LocalStaticPromptReader {
  readBasePrompt(
    agentRole: string | undefined,
    options?: {
      readonly includeAllLayer?: boolean;
      readonly builtinCapabilities?: ResolvedAgentCapabilities;
    },
  ): Promise<string>;
  readSessionPrompt(input: {
    readonly sessionType: 'root' | 'branch';
    readonly agentName: string;
    readonly agentConfigDir?: string;
    readonly builtinCapabilities?: ResolvedAgentCapabilities;
  }): Promise<string>;
  readProjectInstructions(workspaceDir: string): Promise<string>;
  readGlobalInstructions?(dataDir: string): Promise<string>;
}

export interface LocalStaticPromptReaderOptions {
  /** Versioned Agent prompt root owned by local-runtime-v2 composition. */
  readonly assetsDir?: string;
  readonly platform?: NodeJS.Platform;
  readonly logger?: StaticPromptReaderLogger;
  readonly globalInstructions?: GlobalInstructionsPromptReader;
}

export function createLocalStaticPromptReader(
  options: LocalStaticPromptReaderOptions = {},
): LocalStaticPromptReader {
  return {
    async readBasePrompt(agentRole, gates = {}) {
      const root = await requireAgentAssetsDir(options.assetsDir);
      const capabilities = gates.builtinCapabilities ?? resolveAgentCapabilities();
      const names = [
        ...(gates.includeAllLayer === false ? [] : ['prompt-base-all.md']),
        ...(shouldReadWindowsBase(options.platform, capabilities)
          ? ['prompt-base-windows.md']
          : []),
        ...(agentRole === 'orchestrator' ? [] : ['prompt-base-worker.md']),
      ];
      const layers = await Promise.all(
        names.map((name) =>
          readRequiredText(
            join(root, '_default', name),
            `Mandatory local-runtime-v2 base prompt is missing: ${name}.`,
          ),
        ),
      );
      return layers.map((layer) => renderCapabilityTemplate(layer, capabilities)).join('\n\n');
    },
    async readSessionPrompt(input) {
      const root = await requireAgentAssetsDir(options.assetsDir);
      const name =
        input.sessionType === 'root' ? 'prompt-session-root.md' : 'prompt-session-branch.md';
      const canonicalName = input.agentName === 'main' ? 'mavis' : input.agentName;
      const candidates = [
        input.agentConfigDir ? join(input.agentConfigDir, name) : undefined,
        join(root, canonicalName, name),
        join(root, '_default', name),
      ].filter((value): value is string => Boolean(value));
      for (const candidate of candidates) {
        const content = await readTextIfPresent(candidate);
        if (content !== undefined) {
          return renderCapabilityTemplate(
            content,
            input.builtinCapabilities ?? resolveAgentCapabilities(),
          );
        }
      }
      throw new Error(`Mandatory local-runtime-v2 session prompt is missing: ${name}.`);
    },
    async readProjectInstructions(workspaceDir) {
      return (await readProjectInstruction(workspaceDir, options.logger))?.content ?? '';
    },
    async readGlobalInstructions(dataDir) {
      if (options.globalInstructions)
        return (await options.globalInstructions.readForPrompt()) ?? '';
      return readBoundedTextOrEmpty(join(dataDir, 'AGENTS.md'), GLOBAL_INSTRUCTIONS_MAX_BYTES);
    },
  };
}

/** Resolves current instruction sources with the same selection and size rules as Turn assembly. */
export async function readLocalInstructionSources(input: {
  readonly workspaceDir: string;
  readonly dataDir: string;
}): Promise<readonly { readonly scope: 'global' | 'project'; readonly path: string }[]> {
  const globalPath = join(input.dataDir, 'AGENTS.md');
  const [global, project] = await Promise.all([
    readBoundedTextOrEmpty(globalPath, GLOBAL_INSTRUCTIONS_MAX_BYTES),
    readProjectInstruction(input.workspaceDir),
  ]);
  return [
    ...(global.trim() ? [{ scope: 'global' as const, path: globalPath }] : []),
    ...(project ? [{ scope: 'project' as const, path: project.path }] : []),
  ];
}

async function readProjectInstruction(
  workspaceDir: string,
  logger?: StaticPromptReaderLogger,
): Promise<{ readonly path: string; readonly content: string } | undefined> {
  for (const name of [LEGACY_AGENT_INSTRUCTIONS_FILE, 'AGENTS.md']) {
    const path = join(workspaceDir, name);
    const content = await readProjectInstructionsOrEmpty(path, name, logger);
    if (content) return { path, content };
  }
  return undefined;
}

function shouldReadWindowsBase(
  configuredPlatform: NodeJS.Platform | undefined,
  capabilities: ResolvedAgentCapabilities,
): boolean {
  return (
    (configuredPlatform ?? process.platform) === 'win32' &&
    isAgentBuiltinToolEnabled(capabilities, 'bash')
  );
}

export function resolveRuntimeLocale(): string {
  const electron = process.env.MAVIS_ELECTRON_LOCALE?.trim();
  if (electron === 'en' || electron === 'zh') return electron;
  return (
    Intl.DateTimeFormat().resolvedOptions().locale ||
    process.env.LANG?.split('.')[0]?.replace('_', '-') ||
    'en'
  );
}

async function requireAgentAssetsDir(explicit: string | undefined): Promise<string> {
  const root = await resolveAgentAssetsDir(explicit);
  if (root) return root;
  throw new Error('Mandatory local-runtime-v2 Agent prompt asset root is missing.');
}

async function resolveAgentAssetsDir(explicit: string | undefined): Promise<string | undefined> {
  const here = dirname(fileURLToPath(import.meta.url));
  const configured = explicit?.trim();
  const candidates = configured
    ? [configured]
    : [
        resolve(here, '../../../../../assets/agents'),
        resolve(here, 'assets/agents'),
        resolve(process.cwd(), 'assets/agents'),
        resolve(here, 'assets/local-runtime-v2/agents'),
        resolve(process.cwd(), 'packages/local-runtime-v2/assets/agents'),
        resolve(process.cwd(), 'assets/local-runtime-v2/agents'),
      ];
  for (const candidate of candidates) {
    if (await isDirectory(candidate)) return candidate;
  }
  return undefined;
}

async function readProjectInstructionsOrEmpty(
  filePath: string,
  filename: string,
  logger: StaticPromptReaderLogger | undefined,
): Promise<string> {
  try {
    const source = await readFile(filePath);
    const normalized = Buffer.from(source.toString('utf8').trim(), 'utf8');
    if (normalized.byteLength === 0) return '';
    if (normalized.byteLength <= PROJECT_INSTRUCTIONS_MAX_BYTES) {
      return normalized.toString('utf8');
    }
    const content = truncateProjectInstructions(normalized, filename);
    logger?.warn(
      {
        filename,
        originalBytes: source.byteLength,
        injectedBytes: Buffer.byteLength(content, 'utf8'),
        maxBytes: PROJECT_INSTRUCTIONS_MAX_BYTES,
      },
      'Project instructions exceeded the prompt budget and were truncated',
    );
    return content;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

function truncateProjectInstructions(source: Buffer, filename: string): string {
  const separator = '\n\n';
  const notice = [
    `[${filename} content truncated by local-runtime-v2 to fit the ${PROJECT_INSTRUCTIONS_MAX_BYTES}-byte UTF-8 project instructions budget.`,
    `Read the source ${filename} file directly when the omitted instructions are needed.]`,
  ].join('\n');
  const contentBudget =
    PROJECT_INSTRUCTIONS_MAX_BYTES - Buffer.byteLength(separator + notice, 'utf8');
  const prefix = decodeUtf8Prefix(source, contentBudget).trimEnd();
  const lastNewline = prefix.lastIndexOf('\n');
  const completePrefix =
    lastNewline >= Math.floor(prefix.length * 0.8)
      ? prefix.slice(0, lastNewline).trimEnd()
      : prefix;
  return `${completePrefix}${separator}${notice}`;
}

function decodeUtf8Prefix(source: Buffer, maxBytes: number): string {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const endExclusive = Math.min(source.byteLength, maxBytes);
  const minimumEnd = Math.max(0, endExclusive - 3);
  for (let end = endExclusive; end >= minimumEnd; end -= 1) {
    try {
      return decoder.decode(source.subarray(0, end));
    } catch {
      // A UTF-8 code point spans at most four bytes, so only the boundary tail
      // can be incomplete after applying the byte cap.
    }
  }
  return '';
}

async function readBoundedTextOrEmpty(filePath: string, maxBytes: number): Promise<string> {
  try {
    const info = await stat(filePath);
    if (info.size > maxBytes) return '';
    const content = await readFile(filePath, 'utf8');
    return Buffer.byteLength(content, 'utf8') <= maxBytes ? content.trim() : '';
  } catch {
    return '';
  }
}

function renderCapabilityTemplate(
  template: string,
  capabilities: ResolvedAgentCapabilities,
): string {
  return template.replaceAll(
    /\{\{#if features\.([A-Za-z][A-Za-z0-9]*)\}\}([\s\S]*?)\{\{\/if\}\}/gu,
    (_match, feature: string, content: string) =>
      Reflect.get(capabilities.features, feature) === true ? content : '',
  );
}

async function readRequiredText(filePath: string, message: string): Promise<string> {
  const content = await readTextIfPresent(filePath);
  if (content === undefined) throw new Error(message);
  return content;
}

async function readTextIfPresent(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function isDirectory(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isDirectory();
  } catch {
    return false;
  }
}
