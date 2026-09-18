/**
 * mavis-trash.js — Node.js script that moves files to Windows Recycle Bin.
 *
 * Seeded into `<dataDir>/bin/mavis-trash.js` on daemon startup (Windows only).
 * Companion to the POSIX bash `mavis-trash` script (macOS/Linux).
 *
 * Uses PowerShell's Microsoft.VisualBasic.FileIO API to send files/directories
 * to the Recycle Bin, which is the Windows equivalent of macOS Finder Trash.
 *
 * A `.cmd` launcher (`mavis-trash.cmd`) is also seeded so the permission
 * pipeline can invoke `mavis-trash <paths>` uniformly across platforms.
 */

/* eslint-disable no-useless-escape */

/**
 * The Node.js script content. Runs standalone via `node mavis-trash.js [flags] file1 file2 ...`.
 *
 * Matches the bash script's interface:
 * - Silently strips rm-style flags (-r, -f, -rf, --recursive, --force, -R, --)
 * - Resolves relative paths to absolute
 * - Reports per-file success/failure to stdout/stderr
 * - Exit code 0 = all succeeded, 1 = any failed
 *
 * PowerShell invocation strategy:
 * - Files:       [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile(path, UIOption, RecycleOption)
 * - Directories: [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory(path, UIOption, RecycleOption)
 * - UIOption.OnlyErrorDialogs suppresses confirmation prompts
 * - RecycleOption.SendToRecycleBin sends to Recycle Bin instead of permanent delete
 */
export const TRASH_SCRIPT_WIN_CONTENT = `#!/usr/bin/env node
'use strict';

const { execFileSync } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Strip rm-style flags
const RM_FLAGS = new Set(['-r', '-f', '-rf', '-fr', '--recursive', '--force', '-R', '--']);
const files = process.argv.slice(2).filter((arg) => !RM_FLAGS.has(arg));

if (files.length === 0) {
  process.stderr.write('mavis-trash: no files specified\\n');
  process.exit(1);
}

function safeReadlink(absPath) {
  try {
    return fs.readlinkSync(absPath);
  } catch {
    return null;
  }
}

function safeRealpath(absPath) {
  try {
    return fs.realpathSync.native(absPath);
  } catch {
    try {
      return fs.realpathSync(absPath);
    } catch {
      return null;
    }
  }
}

function pathContains(parentPath, childPath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
  );
}

function findProtectedWindowsPath(absPath) {
  const driveRoot = path.parse(absPath).root;
  if (path.resolve(absPath).toLowerCase() === path.resolve(driveRoot).toLowerCase()) {
    return 'drive root';
  }

  const systemDrive = process.env.SystemDrive || driveRoot.slice(0, 2) || 'C:';
  const protectedTrees = [
    ['Windows directory', process.env.SystemRoot || path.join(systemDrive + path.sep, 'Windows')],
    [
      'Program Files directory',
      process.env.ProgramFiles || path.join(systemDrive + path.sep, 'Program Files'),
    ],
    [
      'Program Files (x86) directory',
      process.env['ProgramFiles(x86)'] ||
        path.join(systemDrive + path.sep, 'Program Files (x86)'),
    ],
  ];
  for (const [label, protectedPath] of protectedTrees) {
    if (protectedPath && pathContains(protectedPath, absPath)) {
      return label;
    }
  }

  const protectedAnchors = [
    ['current working directory', process.cwd()],
    ['home directory', os.homedir()],
  ];
  for (const [label, protectedPath] of protectedAnchors) {
    if (protectedPath && pathContains(absPath, protectedPath)) {
      return label;
    }
  }
  return null;
}

function toPowerShellSingleQuoted(value) {
  return "'" + value.replace(/'/g, "''") + "'";
}

function toPowerShellEncodedCommand(command) {
  return Buffer.from(command, 'utf16le').toString('base64');
}

const POWERSHELL_UTF8_PREAMBLE =
  '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding -ArgumentList $false; $OutputEncoding = [Console]::OutputEncoding; ';

function runPowerShellScript(script) {
  return execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      toPowerShellEncodedCommand(POWERSHELL_UTF8_PREAMBLE + script),
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: 30000,
    },
  );
}

function createPowerShellPayloadPath() {
  return path.join(
    os.tmpdir(),
    'mavis-trash-reparse-' +
      process.pid +
      '-' +
      Date.now() +
      '-' +
      Math.random().toString(16).slice(2) +
      '.json',
  );
}

function runPowerShellScriptWithPaths(script, paths) {
  const payloadPath = createPowerShellPayloadPath();
  fs.writeFileSync(payloadPath, JSON.stringify({ paths }), 'utf8');
  const payloadScript = [
    "$payloadPath = " + toPowerShellSingleQuoted(payloadPath) + ";",
    "$payload = Get-Content -LiteralPath $payloadPath -Raw -Encoding UTF8 | ConvertFrom-Json;",
    "$paths = @($payload.paths);",
    script,
  ].join(' ');
  try {
    return runPowerShellScript(payloadScript);
  } finally {
    try {
      fs.unlinkSync(payloadPath);
    } catch {
      // Best effort cleanup only.
    }
  }
}

const REPARSE_ATTRIBUTE_UNKNOWN = 'unknown';
const reparseAttributeCache = new Map();
const reparseTagCache = new Map();

function normalizeStringArray(value) {
  if (Array.isArray(value)) {
    return value.filter((entry) => typeof entry === 'string');
  }
  return typeof value === 'string' ? [value] : [];
}

function parseWindowsReparseAttributeOutput(output) {
  const trimmed = output.trim();
  if (trimmed.length === 0) {
    return [];
  }

  try {
    const result = JSON.parse(trimmed);
    return normalizeStringArray(result?.paths);
  } catch {
    return undefined;
  }
}

function parseWindowsReparseTagProbeOutput(output) {
  const trimmed = output.trim();
  if (trimmed.length === 0) {
    return [];
  }

  try {
    const result = JSON.parse(trimmed);
    const rawResults = Array.isArray(result?.results)
      ? result.results
      : result?.results === undefined
        ? [result]
        : [result.results];
    const parsedResults = [];
    for (const item of rawResults) {
      if (
        item?.kind === 'BLOCK' &&
        typeof item.path === 'string' &&
        typeof item.tag === 'string'
      ) {
        parsedResults.push({
          kind: 'BLOCK',
          path: item.path,
          tag: item.tag,
          inspectionFailed: false,
        });
        continue;
      }
      if (
        item?.kind === 'ALLOW' &&
        typeof item.path === 'string' &&
        typeof item.tag === 'string'
      ) {
        parsedResults.push({
          kind: 'ALLOW',
          path: item.path,
          tag: item.tag,
          inspectionFailed: false,
        });
        continue;
      }
      if (item?.kind === 'FAIL') {
        parsedResults.push({
          kind: 'FAIL',
          path: typeof item.path === 'string' ? item.path : null,
          tag: null,
          inspectionFailed: true,
        });
        continue;
      }
      return undefined;
    }
    return parsedResults;
  } catch {
    return undefined;
  }
}

function createReparseTagProbeFailure(reparsePath) {
  return {
    kind: 'FAIL',
    path: reparsePath,
    tag: null,
    inspectionFailed: true,
  };
}

function findWindowsReparseAttributePaths(paths) {
  const uncachedPaths = paths.filter((candidate) => !reparseAttributeCache.has(candidate));
  if (uncachedPaths.length > 0) {
    const psCommand = [
      "$ErrorActionPreference = 'Stop';",
      "$found = @();",
      "foreach ($p in $paths) {",
      "  $item = Get-Item -LiteralPath $p -Force;",
      "  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { $found += $p }",
      "}",
      "[pscustomobject]@{ paths = @($found) } | ConvertTo-Json -Compress",
    ].join(' ');

    try {
      const output = runPowerShellScriptWithPaths(psCommand, uncachedPaths).toString('utf8');
      const reparsePaths = parseWindowsReparseAttributeOutput(output);
      if (reparsePaths === undefined) {
        for (const candidate of uncachedPaths) {
          reparseAttributeCache.set(candidate, REPARSE_ATTRIBUTE_UNKNOWN);
        }
      } else {
        const reparseSet = new Set(reparsePaths);
        for (const candidate of uncachedPaths) {
          reparseAttributeCache.set(candidate, reparseSet.has(candidate));
        }
      }
    } catch {
      for (const candidate of uncachedPaths) {
        reparseAttributeCache.set(candidate, REPARSE_ATTRIBUTE_UNKNOWN);
      }
    }
  }

  return paths.some((candidate) => reparseAttributeCache.get(candidate) === REPARSE_ATTRIBUTE_UNKNOWN)
    ? undefined
    : paths.filter((candidate) => reparseAttributeCache.get(candidate) === true);
}

function inspectWindowsReparseTags(paths) {
  const uncachedPaths = paths.filter((candidate) => !reparseTagCache.has(candidate));
  if (uncachedPaths.length > 0) {
    const reparseTagReaderSource = [
      'using System;',
      'using System.ComponentModel;',
      'using System.Runtime.InteropServices;',
      'public static class MavisReparseTagReader {',
      '  [StructLayout(LayoutKind.Sequential)]',
      '  public struct FILETIME {',
      '    public uint dwLowDateTime;',
      '    public uint dwHighDateTime;',
      '  }',
      '  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode, Pack = 4)]',
      '  public struct WIN32_FIND_DATA {',
      '    public uint dwFileAttributes;',
      '    public FILETIME ftCreationTime;',
      '    public FILETIME ftLastAccessTime;',
      '    public FILETIME ftLastWriteTime;',
      '    public uint nFileSizeHigh;',
      '    public uint nFileSizeLow;',
      '    public uint dwReserved0;',
      '    public uint dwReserved1;',
      '    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string cFileName;',
      '    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 14)] public string cAlternateFileName;',
      '  }',
      '  [DllImport(\"kernel32.dll\", CharSet = CharSet.Unicode, SetLastError = true)]',
      '  private static extern IntPtr FindFirstFileW(string lpFileName, out WIN32_FIND_DATA lpFindFileData);',
      '  [DllImport(\"kernel32.dll\", SetLastError = true)]',
      '  [return: MarshalAs(UnmanagedType.Bool)]',
      '  private static extern bool FindClose(IntPtr hFindFile);',
      '  public static uint GetTag(string path) {',
      '    WIN32_FIND_DATA data;',
      '    IntPtr handle = FindFirstFileW(path, out data);',
      '    if (handle == new IntPtr(-1)) { throw new Win32Exception(Marshal.GetLastWin32Error()); }',
      '    try { return data.dwReserved0; }',
      '    finally { FindClose(handle); }',
      '  }',
      '}',
    ].join(' ');
    const psCommand = [
      "$ErrorActionPreference = 'Stop';",
      "$source = " + toPowerShellSingleQuoted(reparseTagReaderSource) + ";",
      "Add-Type -TypeDefinition $source;",
      "$results = @();",
      "foreach ($p in $paths) {",
      "  try {",
      "    $item = Get-Item -LiteralPath $p -Force;",
      "    $tag = [MavisReparseTagReader]::GetTag($item.FullName);",
      "    $tagText = ('0x{0:X8}' -f $tag);",
      "    if (($tag -band 0x20000000) -ne 0) {",
      "      $results += [pscustomobject]@{ kind = 'BLOCK'; path = $p; tag = $tagText }",
      "    } else {",
      "      $results += [pscustomobject]@{ kind = 'ALLOW'; path = $p; tag = $tagText }",
      "    }",
      "  } catch {",
      "    $results += [pscustomobject]@{ kind = 'FAIL'; path = $p; tag = $null }",
      "  }",
      "}",
      "[pscustomobject]@{ results = @($results) } | ConvertTo-Json -Compress",
    ].join(' ');

    try {
      const output = runPowerShellScriptWithPaths(psCommand, uncachedPaths).toString('utf8');
      const results = parseWindowsReparseTagProbeOutput(output);
      if (results === undefined) {
        for (const candidate of uncachedPaths) {
          reparseTagCache.set(candidate, createReparseTagProbeFailure(candidate));
        }
      } else {
        const resultByPath = new Map();
        for (const result of results) {
          if (typeof result.path === 'string') {
            resultByPath.set(result.path, result);
          }
        }
        for (const candidate of uncachedPaths) {
          reparseTagCache.set(candidate, resultByPath.get(candidate) ?? createReparseTagProbeFailure(candidate));
        }
      }
    } catch {
      for (const candidate of uncachedPaths) {
        reparseTagCache.set(candidate, createReparseTagProbeFailure(candidate));
      }
    }
  }

  for (const candidate of paths) {
    const result = reparseTagCache.get(candidate) ?? createReparseTagProbeFailure(candidate);
    if (result.kind === 'BLOCK' || result.kind === 'FAIL') {
      return {
        path: result.path,
        tag: result.tag,
        inspectionFailed: result.inspectionFailed,
      };
    }
  }
  return null;
}

function findWindowsRedirectingReparsePoint(paths) {
  const reparsePaths = findWindowsReparseAttributePaths(paths);
  if (reparsePaths === undefined) {
    return {
      path: paths.at(-1) ?? null,
      tag: null,
      inspectionFailed: true,
    };
  }
  if (reparsePaths.length === 0) {
    return null;
  }
  return inspectWindowsReparseTags(reparsePaths);
}

function buildPathChain(absPath) {
  const root = path.parse(absPath).root;
  const relativePath = root === '' ? absPath : absPath.slice(root.length);
  const parts = relativePath.split(/[\\\\/]+/).filter(Boolean);
  if (parts.length === 0) {
    return [absPath];
  }

  const chain = [];
  let current = root;
  for (const part of parts) {
    current = current === '' ? part : path.join(current, part);
    chain.push(current);
  }
  return chain;
}

function inspectSingleLinkLike(absPath, stat) {
  const linkTarget = safeReadlink(absPath);
  if (!stat.isSymbolicLink() && linkTarget === null) {
    return null;
  }

  return {
    isLinkLike: true,
    linkPath: absPath,
    linkTarget,
    realTarget: safeRealpath(absPath),
    inspectionFailed: false,
  };
}

function inspectPathForLinkLike(absPath) {
  const chain = buildPathChain(absPath);
  const stats = new Map();
  for (const candidate of chain) {
    let stat;
    try {
      stat = fs.lstatSync(candidate);
    } catch {
      return { stat: null, linkInfo: null, missingPath: candidate };
    }
    stats.set(candidate, stat);

    const linkInfo = inspectSingleLinkLike(candidate, stat);
    if (linkInfo !== null) {
      return { stat: stats.get(absPath) ?? stat, linkInfo, missingPath: null };
    }
  }

  const reparseInfo = findWindowsRedirectingReparsePoint(chain);
  if (reparseInfo?.inspectionFailed === true) {
    return {
      stat: stats.get(absPath) ?? null,
      linkInfo: {
        isLinkLike: true,
        linkPath: reparseInfo?.path ?? absPath,
        linkTarget: null,
        realTarget: null,
        reparseTag: reparseInfo?.tag ?? null,
        inspectionFailed: true,
      },
      missingPath: null,
    };
  }
  if (reparseInfo !== null) {
    return {
      stat: stats.get(absPath) ?? null,
      linkInfo: {
        isLinkLike: true,
        linkPath: reparseInfo.path,
        linkTarget: null,
        realTarget: null,
        reparseTag: reparseInfo.tag,
        inspectionFailed: false,
      },
      missingPath: null,
    };
  }

  return { stat: stats.get(absPath) ?? null, linkInfo: null, missingPath: null };
}

function getResolvedLinkTarget(linkInfo) {
  if (linkInfo.realTarget !== null) {
    return linkInfo.realTarget;
  }
  if (linkInfo.linkTarget === null) {
    return null;
  }
  return path.isAbsolute(linkInfo.linkTarget)
    ? linkInfo.linkTarget
    : path.resolve(path.dirname(linkInfo.linkPath), linkInfo.linkTarget);
}

function getRefusedTarget(absPath, linkInfo) {
  const resolvedTarget = getResolvedLinkTarget(linkInfo);
  if (resolvedTarget === null || linkInfo.linkPath === absPath) {
    return resolvedTarget;
  }

  const relativeTarget = path.relative(linkInfo.linkPath, absPath);
  return relativeTarget === '' ? resolvedTarget : path.join(resolvedTarget, relativeTarget);
}

function reportRefusedLink(filePath, absPath, linkInfo) {
  const target = getRefusedTarget(absPath, linkInfo);
  const targetText = target ?? 'unresolved target';
  const linkTargetText = linkInfo.linkTarget === null ? '' : " (link target '" + linkInfo.linkTarget + "')";
  const linkPathText = linkInfo.linkPath === absPath ? '' : " (reparse path '" + linkInfo.linkPath + "')";
  const tagText = linkInfo.reparseTag === undefined || linkInfo.reparseTag === null ? '' : " (tag " + linkInfo.reparseTag + ")";
  const guidance = linkInfo.inspectionFailed
    ? '; could not verify Windows reparse point tag, refusing to delete'
    : linkInfo.linkPath === absPath
      ? '; mavis-trash refuses link-like paths and did not recycle this link object'
      : target === null
        ? '; inspect the redirect target explicitly before deleting it'
        : "; run mavis-trash '" + target + "' explicitly if you intend to delete the redirect target";

  process.stderr.write(
    "mavis-trash: refused to trash redirecting reparse point '" + filePath + "' (resolved '" + absPath + "')" +
      linkPathText +
      linkTargetText +
      tagText +
      " -> '" + targetText + "'" +
      guidance +
      "\\n"
  );
}

function trashFile(filePath) {
  // Resolve to absolute path
  const absPath = path.resolve(filePath);

  const protectedReason = findProtectedWindowsPath(absPath);
  if (protectedReason !== null) {
    process.stderr.write(
      "mavis-trash: refused to trash protected Windows path '" +
        filePath +
        "' (resolved '" +
        absPath +
        "', " +
        protectedReason +
        ')\\n',
    );
    return false;
  }

  const pathInfo = inspectPathForLinkLike(absPath);
  if (pathInfo.missingPath !== null) {
    process.stderr.write(\`mavis-trash: '\${filePath}' (resolved '\${absPath}', missing '\${pathInfo.missingPath}'): No such file or directory\\n\`);
    return false;
  }
  if (pathInfo.linkInfo !== null) {
    reportRefusedLink(filePath, absPath, pathInfo.linkInfo);
    return false;
  }
  const stat = pathInfo.stat;
  if (stat === null) {
    process.stderr.write(\`mavis-trash: '\${filePath}' (resolved '\${absPath}'): No such file or directory\\n\`);
    return false;
  }

  // Pick the right API: DeleteFile for files, DeleteDirectory for directories
  const method = stat.isDirectory()
    ? 'DeleteDirectory'
    : 'DeleteFile';

  const psCommand = [
    'Add-Type -AssemblyName Microsoft.VisualBasic;',
    '$pathToTrash = $paths[0];',
    \`[Microsoft.VisualBasic.FileIO.FileSystem]::\${method}(\`,
    '  $pathToTrash,',
    \`  'OnlyErrorDialogs',\`,
    \`  'SendToRecycleBin'\`,
    ')',
  ].join(' ');

  try {
    runPowerShellScriptWithPaths(psCommand, [absPath]);
    return true;
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString().trim() : err.message;
    process.stderr.write(\`mavis-trash: failed to trash '\${absPath}': \${stderr}\\n\`);
    return false;
  }
}

let exitCode = 0;
for (const file of files) {
  if (trashFile(file)) {
    process.stdout.write(\`mavis-trash: moved to trash: '\${file}'\\n\`);
  } else {
    exitCode = 1;
  }
}

process.exit(exitCode);
`;

/**
 * CMD launcher script so that `mavis-trash file.txt` works on Windows
 * without requiring a separately-installed `node` on PATH. The local runtime
 * executable is a bundled Node/Electron runtime; `ELECTRON_RUN_AS_NODE` is
 * ignored by node.exe and makes an Electron executable run the script as Node.
 */
export function buildTrashCmdLauncherContent(runtimeExecutable: string = process.execPath): string {
  const escapedExecutable = runtimeExecutable.replaceAll('%', '%%').replaceAll('"', '""');
  return `@echo off
set "ELECTRON_RUN_AS_NODE=1"
"${escapedExecutable}" "%~dp0mavis-trash.js" %*
`;
}

export const TRASH_CMD_LAUNCHER_CONTENT = buildTrashCmdLauncherContent();
