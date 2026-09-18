import type { TurnEventReporter } from '@mavis/agent-core/pi-turn-runner';

export function createLocalTurnEventReporting(input: {
  readonly turnId: string;
  readonly eventWriter: Pick<TurnEventReporter, 'appendEvents'>;
  readonly eventIdGenerator?: (kind: string) => string;
  readonly runtimeSeqGenerator?: () => number;
}) {
  let eventIdentitySequence = 0;
  let runtimeSequence = 0;
  const eventIdGenerator =
    input.eventIdGenerator ??
    ((kind: string) => `evt_${input.turnId}_${kind}_${++eventIdentitySequence}`);
  const runtimeSeqGenerator = input.runtimeSeqGenerator ?? (() => ++runtimeSequence);
  const reporter: TurnEventReporter = {
    nextEventId: eventIdGenerator,
    nextRuntimeSeq: runtimeSeqGenerator,
    appendEvents: (events) => input.eventWriter.appendEvents(events),
  };
  return { reporter, eventIdGenerator, runtimeSeqGenerator };
}
