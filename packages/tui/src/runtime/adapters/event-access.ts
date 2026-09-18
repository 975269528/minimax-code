import type { CliService } from '@mavis/local-runtime-v2/cli-service';
import type { TuiRuntimeEvent } from '../../types/runtime-events.js';
import { normalizeTuiRuntimeEvent } from '../event-normalizer.js';
import { noopTuiObservability, type TuiObservability } from '../../observability/index.js';

export class TuiEventAccess {
  constructor(
    private readonly cliService: CliService,
    private readonly observability: TuiObservability = noopTuiObservability,
  ) {}

  async *watch(signal: AbortSignal): AsyncGenerator<TuiRuntimeEvent> {
    this.observability.recordAccess({
      operation: 'event.watch',
      source: 'process-local',
    });
    for await (const event of this.cliService.watchEvents(signal)) {
      yield normalizeTuiRuntimeEvent(event);
    }
  }

  watchSessionUsageCommits(signal: AbortSignal): AsyncGenerator<string> {
    this.observability.recordAccess({
      operation: 'event.watch-session-usage-commits',
      source: 'process-local',
    });
    return this.cliService.watchSessionUsageCommits(signal);
  }
}
