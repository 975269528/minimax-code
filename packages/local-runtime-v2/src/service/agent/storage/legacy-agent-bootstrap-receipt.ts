import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { publishFileIfAbsent } from '../../../infra/file/jsonl.js';

const RECEIPT_FILE = 'legacy-agent-bootstrap-import-v1.json';
const RECEIPT_CONTENTS = '{"version":1,"kind":"legacy-agent-bootstrap-import"}\n';

/**
 * Durable one-shot gate for the legacy Agent bootstrap evaluation
 * (collision scan + legacy import) of one data directory.
 *
 * Why a dataDir-level receipt: the bootstrap stages are a one-time catch-up,
 * not a continuous sync. The in-DB eligibility gate (`every creationSource ===
 * 'builtin'`) re-qualifies the target whenever the user deletes every imported
 * Custom Agent row, so deleted legacy Agents were resurrected on every
 * startup. The receipt records "this data directory has terminally evaluated
 * its legacy bootstrap once" outside the DB, so row deletion can never re-arm
 * the import.
 *
 * Why the receipt lives inside `<dataDir>`: its lifetime must match the
 * target it describes. A fresh or migrated data directory has no receipt and
 * therefore keeps its one bootstrap chance automatically — no extra
 * machine-move handling is needed.
 *
 * Structure mirrors `LegacyCustomAgentIdentityReceipt` (a different gate with
 * different semantics; the two are deliberately separate files and classes):
 * `publishFileIfAbsent` + exact-content validation, so a racing writer is
 * safe and an existing valid receipt is never rewritten.
 */
export class LegacyAgentBootstrapImportReceipt {
  constructor(private readonly dataDir: string) {}

  /**
   * A missing receipt reads as incomplete; corrupted contents also read as
   * incomplete (fail-open: the bootstrap evaluation runs again rather than
   * trusting an unverifiable marker). Only unexpected read errors propagate
   * so the caller can log them.
   */
  async isCompleted(): Promise<boolean> {
    try {
      return (await readFile(this.path(), 'utf8')) === RECEIPT_CONTENTS;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async complete(): Promise<void> {
    const outcome = await publishFileIfAbsent(
      this.path(),
      RECEIPT_CONTENTS,
      async (temporaryPath) => {
        if ((await readFile(temporaryPath, 'utf8')) !== RECEIPT_CONTENTS) {
          throw new Error('Legacy Agent bootstrap import receipt validation failed');
        }
      },
    );
    // Never overwrite an existing file: if a receipt is already present but
    // does not verify, surface the corruption instead of silently replacing
    // evidence of a previous completion.
    if (outcome === 'already-exists' && !(await this.isCompleted())) {
      throw new Error('Legacy Agent bootstrap import receipt is invalid');
    }
  }

  /** Exposed so cutover logs can point operators at the exact gate file. */
  path(): string {
    return join(this.dataDir, 'v2', 'migration', 'manifests', RECEIPT_FILE);
  }
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}
