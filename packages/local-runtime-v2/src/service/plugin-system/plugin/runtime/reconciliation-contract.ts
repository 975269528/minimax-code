import type {
  OfficialPluginRepositoryState,
  OfficialPluginInstallationRecord,
} from "./repository.js";

/** Metadata for cache publication transactions; contains no registry endpoint, download, or authentication behavior. */
export interface OfficialPluginMutationState {
  readonly pluginName: string;
  readonly installExists: boolean;
  readonly enabled: boolean;
  readonly installationPolicy: OfficialPluginInstallationRecord["installationPolicy"];
  readonly package?: {
    readonly name: string;
    readonly version: string;
    readonly archiveSha256: string;
    readonly contentDigest: string;
  };
}
export interface PreparedOfficialPluginReconciliation {
  readonly state: OfficialPluginRepositoryState;
  readonly changed: boolean;
  readonly incomplete: boolean;
  readonly failedPackageCount: number;
  commit(): boolean;
  rollback(): void;
  abort(): Promise<void>;
  finalize(): Promise<void>;
}
