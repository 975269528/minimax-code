/**
 * Bash fast-allow first-word extraction + hard-block reason formatting.
 *
 * Extracted from `bash-permission.ts` to keep that module under the
 * 2000-line pre-commit block. Pure functions on shell text — no
 * permission state.
 *
 * Two exports:
 *   1. {@link pureReadFirstWord} — Step 9 fast-allow gate input.
 *      Strips env-var prefixes, the `env [-i] K=V` envelope, and
 *      transparent wrappers (nohup / setsid / xargs / timeout / ...)
 *      so the gate sees the actual command name. Bails (returns
 *      undefined) on env-var-target deception shapes
 *      (`TARGET=/etc/shadow cat $TARGET`).
 *   2. {@link formatHardBlockedBashReason} — user-facing message
 *      builder for HARD_BLOCKED categories surfaced to the ASK card
 *      or final deny.
 */

import { shellTokenize } from './shell-tokenize.js';
import { consumeShellWrapperPrefix } from './bash-wrapper-unwrap.js';

/**
 * Extract the first whitespace token of a command. Used by the pure-read
 * fast-allow gate to identify the actual command name.
 *
 * Returns `undefined` whenever the command's leading shape is suspicious
 * enough that the fast-allow shortcut would hide intent:
 *   - inline scripts (`bash -c "…"`, `sh -c "…"`) — first token is the
 *     interpreter, not the payload; SOFT pre-scan handles those
 *   - any leading path component other than a normal absolute-path
 *     basename (relative paths like `./run.sh` are left alone)
 *
 * Env-var assignment prefixes (`MAVIS_SESSION=foo MAVIS_PORT=1 git commit …`)
 * are SKIPPED to find the real command word. To prevent deception via
 * `TARGET=/etc/shadow cat $TARGET`, we ALSO bail out when the post-prefix
 * command tokens reference ANY of the assigned variable names via `$VAR` /
 * `${VAR}` expansion. In that case the surface command-name (`cat`) hides
 * the actual target path encoded in the env value.
 *
 * Transparent wrappers (`xargs`, `nohup`, `setsid`, `nice`, `timeout`,
 * `command`, `parallel`, `watch`) are unwrapped via
 * {@link consumeShellWrapperPrefix} so `xargs grep` / `nohup tail -f` /
 * `timeout 30 ls` see the inner cmd as the effective first word. `sudo`
 * is deliberately NOT stripped — it is already routed to ask by
 * SUBCOMMAND_DANGEROUS; `exec` is not stripped either because it
 * replaces the shell process.
 */
export function pureReadFirstWord(command: string): string | undefined {
  // POSIX shell line-continuation: `\` followed by a newline is the same as
  // a single whitespace. Without this fold the tokenizer keeps the literal
  // backslash, mis-identifying `MAVIS_SESSION=x \↵ git push` as starting
  // with `\` instead of `git`. Apply BEFORE shellTokenize so all downstream
  // (env-var prefix skip, command-word extraction) sees the joined form.
  const joined = command.replace(/\\\r?\n/g, ' ');
  const tokens = shellTokenize(joined.trim());
  let i = 0;
  const assignedVars: string[] = [];
  while (i < tokens.length) {
    const tok = tokens[i] ?? '';
    const m = tok.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (!m) break;
    assignedVars.push(m[1]!);
    i++;
  }
  // env-var prefix can also take the form `env [-i] K=V K=V <cmd>`. Detect
  // and skip past it so the actual command word is what we evaluate. `env -i`
  // explicitly clears the environment first — same risk profile as plain
  // `K=V cmd` prefixes (the eventually-invoked binary is what matters).
  if (tokens[i] === 'env') {
    let j = i + 1;
    if (tokens[j] === '-i') j++;
    while (j < tokens.length) {
      const t = tokens[j] ?? '';
      const m = t.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
      if (!m) break;
      assignedVars.push(m[1]!);
      j++;
    }
    if (j < tokens.length) {
      i = j;
    }
  }
  // Strip transparent wrapper prefixes after env-var handling. Wrappers
  // themselves do not introduce new variable bindings, so the
  // `assignedVars` $VAR reference check below remains complete on the
  // post-strip token tail.
  i = consumeShellWrapperPrefix(tokens, i);
  const first = tokens[i];
  if (!first) return undefined;

  if (assignedVars.length > 0) {
    // Refuse to fast-allow if any subsequent token references an assigned
    // var via `$VAR` / `${VAR}`. We're conservative — also bail on `$@` /
    // `$*` / `$1` since those expand to caller-controlled values.
    const tail = tokens.slice(i + 1).join(' ');
    for (const v of assignedVars) {
      const re = new RegExp(`\\$${v}\\b|\\$\\{${v}[}:]`);
      if (re.test(tail)) return undefined;
    }
  }

  // Strip leading absolute-path component so an absolute-path invocation
  // is recognised as the bare command name (POSIX shell text — not an OS
  // file path). Relative names (`./foo.sh`) are left untouched.
  const exe = first[0] === '/' ? (first.split('/').pop() ?? first) : first;
  return exe.toLowerCase();
}

/**
 * User-facing reason text for HARD_BLOCKED categories. Surfaced on
 * permission cards (ASK) and final deny messages.
 */
export function formatHardBlockedBashReason(
  command: string,
  category: string,
  description: string,
): string {
  if (
    category === 'sensitive-read' ||
    category === 'system-secret' ||
    category === 'ssh-credential'
  ) {
    return `Needs confirmation: sensitive credential or system-secret read requires LLM review and explicit approval if the LLM cannot allow it. Command: ${command}. Reason: ${description}.`;
  }
  if (category === 'data-exfil') {
    return `Blocked: command appears to exfiltrate credential or secret material. Command: ${command}. Reason: ${description}.`;
  }
  if (
    category === 'irrecoverable-delete' ||
    category === 'disk-erase' ||
    category === 'storage-volume-delete' ||
    category === 'windows-secure-erase' ||
    category === 'windows-delete' ||
    category === 'ransomware-indicator' ||
    category === 'fs-inode-direct' ||
    category === 'archive-remove-source'
  ) {
    const base = `Blocked: command can irreversibly destroy files, disks, or backups. Command: ${command}. Reason: ${description}.`;
    if (category === 'windows-delete') {
      return `${base} Use \`mavis-trash <path>\` for recoverable removal, or drop bypass for this call.`;
    }
    return base;
  }
  if (category === 'reverse-shell' || category === 'encoding-bypass') {
    if (category === 'encoding-bypass') {
      return `Blocked: encoded shell execution hides the payload and has no reliable review surface. Command: ${command}. Reason: ${description}.`;
    }
    return `Needs confirmation: command opens a raw shell/network channel and requires LLM review; if the LLM cannot allow it, explicit approval is required. Command: ${command}. Reason: ${description}.`;
  }
  return `Blocked: command matches a final safety boundary. Command: ${command}. Reason: ${description}.`;
}
