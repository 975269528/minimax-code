import path from "node:path";
const TEST_DIRECTORY_NAMES = new Set(["test", "tests", "__tests__"]);

export function isTuiNonRuntimeResourcePath(sourcePath) {
  const normalized = String(sourcePath).replaceAll(
    path.win32.sep,
    path.posix.sep,
  );
  const segments = normalized.split("/").filter(Boolean);
  const baseName = (segments.at(-1) ?? "").toLowerCase();
  if (baseName === "__pycache__" || baseName.endsWith(".pyc")) return true;
  if (baseName.endsWith(".map") || baseName.endsWith(".snap")) return true;
  if (
    segments.some((segment) => TEST_DIRECTORY_NAMES.has(segment.toLowerCase()))
  )
    return true;
  return (
    /\.(?:test|spec)\.[^.]+$/u.test(baseName) ||
    /^test(?:[_-].+)?\.[^.]+$/u.test(baseName) ||
    /[_-]test\.[^.]+$/u.test(baseName)
  );
}

export function shouldCopyTuiRuntimeResource(sourcePath) {
  return !isTuiNonRuntimeResourcePath(sourcePath);
}
