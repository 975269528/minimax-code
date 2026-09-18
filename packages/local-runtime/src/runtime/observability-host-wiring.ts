import type { MetricsClient, ModuleMetricsReporter } from '../common/metrics.js';
import type { LocalRuntimeTelemetrySink } from '../sessions/router.js';

export type { ModuleMetricsReporter };

/**
 * Bridge facade `MetricsClient` (counter/gauge/histogram) to module
 * reporter ports (`incr/gauge/latency`).
 *
 * Metric names pass through VERBATIM and must stay BARE
 * (`hook_execution_total`, `cron_task_executed_total`, …): the metrics
 * server prepends the service name (`local_runtime_`) on ingest, so any
 * client-side prefixing would store double-prefixed series.
 *
 * `assertLocalMetricName` is exported from `common/metrics.ts` for callers
 * who want a belt-and-suspenders check at the emit site; the adapter itself
 * stays silent on the hot path so a single stray name never breaks user
 * channel turns.
 */
export function createLocalRuntimeMetricsReporter(client: MetricsClient): ModuleMetricsReporter {
  return {
    incr(name, tags) {
      client.counter(name, 1, tags ?? {});
    },
    gauge(name, value, tags) {
      client.gauge(name, value, tags ?? {});
    },
    latency(name, durationMs, tags) {
      client.histogram(name, durationMs, tags ?? {});
    },
  };
}

export function composeTelemetrySinks(
  first: LocalRuntimeTelemetrySink | undefined,
  second: LocalRuntimeTelemetrySink | undefined,
): LocalRuntimeTelemetrySink | undefined {
  if (!first) return second;
  if (!second) return first;
  return (event) => {
    first(event);
    second(event);
  };
}
