import type { CliService } from '@mavis/local-runtime-v2/cli-service';
import {
  noopTuiObservability,
  type TuiObservability,
  type TuiRuntimeAccessSource,
} from '../../observability/index.js';

export interface TuiRuntimeAccessContextOptions {
  readonly cliService: CliService;
  readonly observability?: TuiObservability;
}

export class TuiRuntimeAccessContext {
  private readonly cliService: CliService;
  private readonly observability: TuiObservability;

  constructor(options: TuiRuntimeAccessContextOptions) {
    this.cliService = options.cliService;
    this.observability = options.observability ?? noopTuiObservability;
  }

  service(operation = 'runtime.cli-service'): CliService {
    this.recordAccess(operation, 'process-local');
    return this.cliService;
  }

  private recordAccess(operation: string, source: TuiRuntimeAccessSource): void {
    this.observability.recordAccess({ operation, source });
  }
}
