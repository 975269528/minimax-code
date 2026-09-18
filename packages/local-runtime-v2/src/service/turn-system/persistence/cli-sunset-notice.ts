import type { AppDb } from '../../../infra/db/client.js';
import { readPreferenceValue, upsertPreferenceValue } from '../../../infra/db/preference-values.js';

const FIRST_BOOT_KEY = 'cliSunsetNotice.firstBootAt';
const FIRST_FIRED_KEY = 'cliSunsetNotice.firstFiredAt';
const NOTICE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const REMOVED_CLI_PATTERN =
  /\bmavis\s+(?:agent|communication|cron|session|memory|skill|hook|spawn)\b/;
const TEAM_CLI_PATTERN = /\bmavis\s+team\b/;

export interface CliSunsetCandidateFile {
  readonly path: string;
  readonly content: string;
  readonly mtimeMs: number;
}

export interface CliSunsetMemoryNotice {
  readonly paths: string[];
  readonly teamPaths: string[];
}

/** Owns the bounded compatibility notice state for stale Memory CLI instructions. */
export class CliSunsetNotice {
  constructor(private readonly db: AppDb) {}

  async evaluate(
    nowMs: number,
    loadFiles: () => Promise<readonly CliSunsetCandidateFile[]>,
  ): Promise<CliSunsetMemoryNotice | undefined> {
    try {
      const firstFiredAt = asUnixMs(readPreferenceValue(this.db, FIRST_FIRED_KEY));
      if (firstFiredAt !== undefined && nowMs >= firstFiredAt + NOTICE_WINDOW_MS) {
        return undefined;
      }

      let firstBootAt = asUnixMs(readPreferenceValue(this.db, FIRST_BOOT_KEY));
      if (firstBootAt === undefined) {
        firstBootAt = nowMs;
        upsertPreferenceValue(this.db, FIRST_BOOT_KEY, nowMs);
      }

      const staleFiles = (await loadFiles()).filter((file) => file.mtimeMs < firstBootAt);
      const paths = staleFiles
        .filter((file) => REMOVED_CLI_PATTERN.test(file.content))
        .map((file) => file.path);
      const teamPaths = staleFiles
        .filter((file) => TEAM_CLI_PATTERN.test(file.content))
        .map((file) => file.path);
      if (paths.length === 0 && teamPaths.length === 0) return undefined;

      if (firstFiredAt === undefined) {
        upsertPreferenceValue(this.db, FIRST_FIRED_KEY, nowMs);
      }
      return { paths, teamPaths };
    } catch {
      return undefined;
    }
  }
}

function asUnixMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
