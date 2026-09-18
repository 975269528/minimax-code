import { extname } from 'node:path';

import { sanitizeTerminalText } from '../../rendering/terminal-text.js';
import { tuiMarkdownTheme } from '../../theme/runtime.js';

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.bash': 'bash',
  '.c': 'c',
  '.cc': 'cpp',
  '.cpp': 'cpp',
  '.css': 'css',
  '.go': 'go',
  '.h': 'c',
  '.hpp': 'cpp',
  '.html': 'html',
  '.java': 'java',
  '.js': 'javascript',
  '.json': 'json',
  '.jsx': 'jsx',
  '.md': 'markdown',
  '.mjs': 'javascript',
  '.py': 'python',
  '.rb': 'ruby',
  '.rs': 'rust',
  '.sh': 'bash',
  '.sql': 'sql',
  '.toml': 'toml',
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.zsh': 'bash',
};

export function syntaxLanguageForPath(filePath: string | undefined): string | undefined {
  if (!filePath) return undefined;
  const basename = filePath.split(/[\\/]/u).at(-1)?.toLocaleLowerCase();
  if (basename === 'dockerfile') return 'dockerfile';
  if (basename === 'makefile') return 'makefile';
  return LANGUAGE_BY_EXTENSION[extname(filePath).toLocaleLowerCase()];
}

export function highlightSyntaxLines(code: string, language?: string): string[] {
  const safeCode = sanitizeTerminalText(code);
  return tuiMarkdownTheme.highlightCode?.(safeCode, language) ?? safeCode.split('\n');
}

export function highlightFileLines(code: string, filePath?: string): string[] {
  return highlightSyntaxLines(code, syntaxLanguageForPath(filePath));
}

export function highlightDiffContents(lines: readonly string[], filePath?: string): string[] {
  const code = lines.map(diffCodeContent).join('\n');
  return highlightFileLines(code, filePath);
}

function diffCodeContent(line: string): string {
  if (isDiffMetadata(line)) return '';
  return /^[+\- ]/u.test(line) ? line.slice(1) : line;
}

function isDiffMetadata(line: string): boolean {
  return (
    line.startsWith('@@') ||
    line.startsWith('diff --git ') ||
    line.startsWith('index ') ||
    line.startsWith('--- ') ||
    line.startsWith('+++ ')
  );
}
