/**
 * Conservative provenance-only shell scanning (never used to execute commands).
 * Keep operands with the cwd at their position. Dynamic control flow, subshells
 * and expansions cannot establish a trustworthy relative-path identity.
 */
export function shellSourceStages(
  command: string,
  initialDirectory: string | undefined,
  resolve: (path: string, directory: string | undefined) => string | undefined,
): Array<{ command: string; directory: string | undefined }> {
  const parts: Array<{ command: string; separator: string }> = [];
  let start = 0;
  let quote = '';
  for (let i = 0; i < command.length; i += 1) {
    const char = command.charAt(i);
    if (char === '`' || (char === '$' && quote !== "'")) return [];
    if (quote) {
      if (char === quote) quote = '';
      else if (char === '\\' && quote === '"' && command[i + 1] === '"') i += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '\\' && /[\s;&|()'"`]/u.test(command[i + 1] ?? '')) return [];
    if ('(){}#'.includes(char) || command.slice(i, i + 2) === '<<') return [];
    if (char === '&' && /[<>]/u.test(command[i - 1] ?? '') && /[\d-]/u.test(command[i + 1] ?? ''))
      continue;
    if (char === ';' || char === '\n' || char === '&' || char === '|') {
      let separator = char;
      if (command[i + 1] === char && (char === '&' || char === '|')) separator += command[++i];
      if (separator === '&' || separator === '||') return [];
      parts.push({ command: command.slice(start, i + 1 - separator.length).trim(), separator });
      start = i + 1;
    }
  }
  if (quote) return [];
  parts.push({ command: command.slice(start).trim(), separator: '' });
  if (
    parts.some((part) =>
      /^(?:if|then|else|fi|for|while|until|case|function|pushd|popd)\b/u.test(part.command),
    )
  )
    return [];
  if (
    parts.some((part) => part.separator === '|') &&
    parts.some((part) => /^cd\b/u.test(part.command))
  )
    return [];
  let directory = initialDirectory;
  const stages: Array<{ command: string; directory: string | undefined }> = [];
  for (const part of parts) {
    if (/^cd\b/u.test(part.command)) {
      const match = /^cd\s+(?:--\s+)?(?:"([^"\n]+)"|'([^'\n]+)'|([^\s;&|]+))\s*$/u.exec(
        part.command,
      );
      const target = match?.[1] ?? match?.[2] ?? match?.[3];
      // Only && establishes that cd succeeded before the subsequent command.
      directory =
        target && !/^[~-]/u.test(target) && part.separator === '&&'
          ? resolve(target, directory)
          : undefined;
    } else if (part.command) {
      stages.push({ command: part.command, directory });
    }
  }
  return stages;
}
