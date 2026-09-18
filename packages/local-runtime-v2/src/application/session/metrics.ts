/** Low-cardinality Session metrics shared by Desktop-facing use cases. */
export interface ApplicationMetricsClient {
  counter(name: string, value: number, tags?: Record<string, string>): void;
}

/** Metrics are diagnostic only and must never change the application result. */
export function countApplicationMetric(
  metrics: ApplicationMetricsClient | undefined,
  name: string,
  tags: Record<string, string>,
): void {
  try {
    metrics?.counter(name, 1, tags);
  } catch {
    // A telemetry outage must not turn a successful Desktop operation into a failure.
  }
}
