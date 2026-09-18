import fs from 'node:fs';
import path from 'node:path';

import type { MavisBuildEnv, MavisRegion } from '@mavis/config';

const REGION_PREFERENCE_DIRECTORY = 'preferences';
const REGION_PREFERENCE_FILE = 'mcode-region.json';

interface TuiRegionPreferenceRecord {
  readonly version: 1;
  readonly regions: Partial<Record<MavisBuildEnv, MavisRegion>>;
  readonly updatedAtMs: number;
}

export interface TuiRegionPreference {
  readonly buildEnv: MavisBuildEnv;
  readonly region: MavisRegion;
}

export function readTuiRegionPreference(
  dataDir: string,
  buildEnv: MavisBuildEnv,
): MavisRegion | undefined {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(resolveTuiRegionPreferencePath(dataDir), 'utf8'),
    ) as Partial<TuiRegionPreferenceRecord>;
    if (parsed.version !== 1 || !parsed.regions || typeof parsed.regions !== 'object') {
      return undefined;
    }
    const region = parsed.regions[buildEnv];
    return region === 'cn' || region === 'en' ? region : undefined;
  } catch {
    return undefined;
  }
}

export function writeTuiRegionPreference(dataDir: string, preference: TuiRegionPreference): string {
  const directory = path.join(dataDir, REGION_PREFERENCE_DIRECTORY);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filePath = resolveTuiRegionPreferencePath(dataDir);
  const currentRegions = readRegionPreferences(filePath);
  const record: TuiRegionPreferenceRecord = {
    version: 1,
    regions: { ...currentRegions, [preference.buildEnv]: preference.region },
    updatedAtMs: Date.now(),
  };
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  fs.renameSync(temporaryPath, filePath);
  return filePath;
}

function resolveTuiRegionPreferencePath(dataDir: string): string {
  return path.join(dataDir, REGION_PREFERENCE_DIRECTORY, REGION_PREFERENCE_FILE);
}

function readRegionPreferences(filePath: string): TuiRegionPreferenceRecord['regions'] {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(filePath, 'utf8'),
    ) as Partial<TuiRegionPreferenceRecord>;
    if (parsed.version !== 1 || !parsed.regions || typeof parsed.regions !== 'object') return {};
    return Object.fromEntries(
      Object.entries(parsed.regions).filter(
        ([buildEnv, region]) =>
          (buildEnv === 'dev' ||
            buildEnv === 'test' ||
            buildEnv === 'staging' ||
            buildEnv === 'prod') &&
          (region === 'cn' || region === 'en'),
      ),
    ) as TuiRegionPreferenceRecord['regions'];
  } catch {
    return {};
  }
}
