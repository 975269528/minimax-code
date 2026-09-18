import type {
  CronExecutionMetricResult,
  CronMetricTask,
  CronMetrics,
  CronMetricsClient,
  CronMutationMetricSource,
  CronTriggerMetricOutcome,
  CronTriggerMetricSource,
} from '../contracts.js';

export function createCronMetrics(client?: CronMetricsClient): CronMetrics {
  return new ClientCronMetrics(client);
}

class ClientCronMetrics implements CronMetrics {
  constructor(private readonly client: CronMetricsClient | undefined) {}

  engineStarted(): void {
    this.report(() => this.client?.counter('cron_engine_started_total'));
  }

  taskCreated(task: CronMetricTask, source: CronMutationMetricSource): void {
    this.reportMutation('cron_task_created_total', task, source);
  }

  taskUpdated(task: CronMetricTask, source: CronMutationMetricSource): void {
    this.reportMutation('cron_task_updated_total', task, source);
  }

  taskDeleted(task: CronMetricTask, source: CronMutationMetricSource): void {
    this.reportMutation('cron_task_deleted_total', task, source);
  }

  taskTriggered(
    task: CronMetricTask,
    source: CronTriggerMetricSource,
    outcome: CronTriggerMetricOutcome,
  ): void {
    this.report(() =>
      this.client?.counter('cron_task_triggered_total', 1, {
        trigger_source: source,
        trigger_outcome: outcome,
        ...taskLabels(task),
      }),
    );
  }

  taskExecuted(agentName: string, result: CronExecutionMetricResult, durationMs: number): void {
    const labels = { result, agent_name: agentName };
    this.report(() => this.client?.counter('cron_task_executed_total', 1, labels));
    this.report(() =>
      this.client?.histogram('cron_task_execution_duration_ms', Math.max(0, durationMs), {
        agent_name: agentName,
      }),
    );
  }

  taskFailed(agentName: string, errorCode: string): void {
    this.report(() =>
      this.client?.counter('cron_task_execution_failure_total', 1, {
        error_code: errorCode,
        agent_name: agentName,
      }),
    );
  }

  private reportMutation(
    name: 'cron_task_created_total' | 'cron_task_updated_total' | 'cron_task_deleted_total',
    task: CronMetricTask,
    source: CronMutationMetricSource,
  ): void {
    this.report(() =>
      this.client?.counter(name, 1, {
        mutation_source: source,
        ...taskLabels(task),
      }),
    );
  }

  private report(operation: () => void): void {
    try {
      operation();
    } catch {
      // Metrics remain observational and cannot change Cron behavior.
    }
  }
}

function taskLabels(task: CronMetricTask): Record<string, string> {
  return {
    owner_agent: task.agentName,
    schedule_type: task.schedule.kind === 'once' ? 'once' : 'cron',
    delivery_target: task.sessionTarget.mode === 'new' ? 'new' : 'session_id',
  };
}
