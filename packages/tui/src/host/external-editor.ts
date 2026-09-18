import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface ResolveTuiExternalEditorCommandOptions {
  readonly configuredCommand?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}

export interface ParsedTuiExternalEditorCommand {
  readonly executable: string;
  readonly args: readonly string[];
}

export interface TuiExternalEditorProcessInvocation {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly shell: boolean;
}

export interface TuiExternalEditorProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

export type TuiExternalEditorProcessRunner = (
  invocation: TuiExternalEditorProcessInvocation,
) => Promise<TuiExternalEditorProcessResult>;

export interface EditTuiDraftInExternalEditorOptions {
  readonly command: string;
  readonly draft: string;
  readonly cwd: string;
  readonly platform?: NodeJS.Platform;
  readonly runProcess?: TuiExternalEditorProcessRunner;
}

export type EditTuiDraftInExternalEditor = (
  options: EditTuiDraftInExternalEditorOptions,
) => Promise<string>;

export function resolveTuiExternalEditorCommand(
  options: ResolveTuiExternalEditorCommandOptions = {},
): string | undefined {
  const env = options.env ?? process.env;
  const configured = [options.configuredCommand, env.MCODE_EDITOR, env.VISUAL, env.EDITOR].find(
    (value) => value?.trim(),
  );
  if (configured) return configured.trim();
  return (options.platform ?? process.platform) === 'win32' ? 'notepad' : undefined;
}

export function parseTuiExternalEditorCommand(command: string): ParsedTuiExternalEditorCommand {
  const tokens: string[] = [];
  let current = '';
  let quote: "'" | '"' | undefined;
  let tokenStarted = false;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index] ?? '';
    if (quote) {
      if (character === quote) {
        quote = undefined;
        tokenStarted = true;
        continue;
      }
      if (character === '\\' && quote === '"') {
        const next = command[index + 1];
        if (next === '"' || next === '\\') {
          current += next;
          index += 1;
          tokenStarted = true;
          continue;
        }
      }
      current += character;
      tokenStarted = true;
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      tokenStarted = true;
      continue;
    }
    if (/\s/u.test(character)) {
      if (tokenStarted) {
        tokens.push(current);
        current = '';
        tokenStarted = false;
      }
      continue;
    }
    if (character === '\\') {
      const next = command[index + 1];
      if (next && (/\s/u.test(next) || next === "'" || next === '"' || next === '\\')) {
        current += next;
        index += 1;
        tokenStarted = true;
        continue;
      }
    }
    current += character;
    tokenStarted = true;
  }

  if (quote) throw new Error('External editor command has an unmatched quote.');
  if (tokenStarted) tokens.push(current);
  const [executable, ...args] = tokens;
  if (!executable) throw new Error('External editor command is empty.');
  return { executable, args };
}

export async function editTuiDraftInExternalEditor(
  options: EditTuiDraftInExternalEditorOptions,
): Promise<string> {
  const parsed = parseTuiExternalEditorCommand(options.command);
  const directory = await mkdtemp(join(tmpdir(), 'mcode-editor-'));
  const draftPath = join(directory, 'prompt.md');
  try {
    await writeFile(draftPath, normalizeLineEndings(options.draft), {
      encoding: 'utf8',
      mode: 0o600,
    });
    const result = await (options.runProcess ?? runExternalEditorProcess)({
      executable: parsed.executable,
      args: [...parsed.args, draftPath],
      cwd: options.cwd,
      shell: (options.platform ?? process.platform) === 'win32',
    });
    assertExternalEditorSucceeded(result);
    return normalizeLineEndings(await readFile(draftPath, 'utf8'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function runExternalEditorProcess(
  invocation: TuiExternalEditorProcessInvocation,
): Promise<TuiExternalEditorProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.executable, invocation.args, {
      cwd: invocation.cwd,
      stdio: 'inherit',
      // Match Pi's Windows path: an async shell child lets libuv release its
      // console read before the TUI re-enables raw input after the editor exits.
      shell: invocation.shell,
    });
    child.once('error', reject);
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
  });
}

function assertExternalEditorSucceeded(result: TuiExternalEditorProcessResult): void {
  if (result.exitCode === 0) return;
  if (result.signal) throw new Error(`External editor exited after signal ${result.signal}`);
  throw new Error(`External editor exited with code ${String(result.exitCode)}`);
}

function normalizeLineEndings(value: string): string {
  return value.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n');
}
