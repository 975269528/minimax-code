import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { TerminalDeliveredAsset } from '../../application/assistant-content.js';
import { hyperlink } from '../engine/public.js';
import { sanitizeTerminalText } from '../rendering/terminal-text.js';
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '../rendering/text.js';
import { tuiChalk as chalk, tuiColors as colors } from '../theme/runtime.js';

export function renderDeliveredAssets(
  assets: readonly TerminalDeliveredAsset[],
  width: number,
  workspaceDir = process.cwd(),
): string[] {
  const normalizedWidth = Math.max(0, Math.floor(width));
  if (assets.length === 0 || normalizedWidth === 0) return [];

  const label = 'Created  ';
  const labelWidth = visibleWidth(label);
  const continuation = ' '.repeat(labelWidth);
  const lines: string[] = [];

  assets.forEach((asset, index) => {
    const path = sanitizeTerminalText(asset.path).trim();
    const file = compactAssetPath(path, workspaceDir);
    const caption = displayAssetCaption(asset, path, file);
    const href = assetHyperlink(path, workspaceDir);
    const prefix = chalk.hex(colors.dim)(index === 0 ? label : continuation);
    const detail = caption ? chalk.hex(colors.muted)(`  ·  ${caption}`) : '';
    lines.push(
      ...renderPrefixedText(
        `${renderAssetLink(`${file || 'file'} ↗`, href)}${detail}`,
        prefix,
        chalk.hex(colors.dim)(continuation),
        normalizedWidth,
      ),
    );
  });

  return lines;
}

function renderAssetLink(text: string, href: string | undefined): string {
  const highlighted = chalk.underline.hex(colors.signal)(text);
  // Pi Main and Alt surfaces leave OSC 8 handling to the terminal, so the same semantic link
  // works in terminal-native scrollback and fullscreen composition.
  return href ? hyperlink(highlighted, href) : highlighted;
}

function assetHyperlink(path: string, workspaceDir: string): string | undefined {
  if (/^https?:\/\//iu.test(path) || /^file:\/\//iu.test(path)) return path;
  const looksLocal =
    isAbsolute(path) ||
    path.startsWith('./') ||
    path.startsWith('../') ||
    /[\\/]/u.test(path) ||
    /\.[A-Za-z0-9]{1,12}$/u.test(path);
  if (!looksLocal) return undefined;
  try {
    return pathToFileURL(resolve(workspaceDir, path)).href;
  } catch {
    return undefined;
  }
}

function compactAssetPath(path: string, workspaceDir: string): string {
  if (!path) return 'file';
  try {
    if (/^https?:\/\//iu.test(path)) {
      const url = new URL(path);
      return basename(decodeURIComponent(url.pathname)) || url.hostname;
    }
    const localPath = /^file:\/\//iu.test(path) ? fileURLToPath(path) : path;
    const absolutePath = isAbsolute(localPath) ? localPath : resolve(workspaceDir, localPath);
    const workspacePath = relative(workspaceDir, absolutePath);
    if (
      workspacePath &&
      workspacePath !== '..' &&
      !workspacePath.startsWith(`..${sep}`) &&
      !isAbsolute(workspacePath)
    ) {
      return workspacePath.split(sep).join('/');
    }
    return basename(localPath) || localPath;
  } catch {
    return basename(path) || path;
  }
}

function displayAssetCaption(
  asset: TerminalDeliveredAsset,
  path: string,
  file: string,
): string | undefined {
  const rawName = sanitizeTerminalText(asset.name ?? '').trim();
  const pathBasename = path.split(/[\\/]/u).filter(Boolean).at(-1);
  if (!rawName || rawName === path || rawName === pathBasename || rawName === file)
    return undefined;

  const embeddedPathStart = path ? rawName.indexOf(path) : -1;
  const caption = (embeddedPathStart < 0 ? rawName : rawName.slice(0, embeddedPathStart))
    .trimEnd()
    .replace(/[\s·•|:—–-]+$/u, '')
    .trimEnd();
  return caption && caption !== file && caption !== pathBasename ? caption : undefined;
}

function renderPrefixedText(
  text: string,
  firstPrefix: string,
  continuationPrefix: string,
  width: number,
): string[] {
  const firstWidth = Math.max(1, width - visibleWidth(firstPrefix));
  const continuationWidth = Math.max(1, width - visibleWidth(continuationPrefix));
  const wrapped = wrapTextWithAnsi(text, Math.min(firstWidth, continuationWidth));
  if (wrapped.length === 0) return [truncateToWidth(firstPrefix, width, '')];
  return wrapped.map((line, index) =>
    truncateToWidth(`${index === 0 ? firstPrefix : continuationPrefix}${line}`, width, ''),
  );
}
