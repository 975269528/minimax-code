import type { MavisBuildEnv, MavisRegion } from '@mavis/config';

export interface CliAuthScope {
  readonly region: MavisRegion;
  readonly buildEnv: MavisBuildEnv;
}
