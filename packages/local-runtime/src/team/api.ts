import { randomBytes } from 'node:crypto';
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { json, notFound } from '../api/host-helpers.js';
import type { LocalSessionRecord } from '../sessions/controller.js';

type PlanStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

const PLAN_ID_PATTERN = /^plan_[0-9a-f]{8}$/u;
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

interface LocalTeamPlanRecord {
  plan: Record<string, unknown>;
  state: Record<string, unknown> & {
    plan_id: string;
    status: PlanStatus;
    owner_session_id: string;
    owner_agent_name?: string;
    cycle: number;
    phase: string;
    results: Array<Record<string, unknown> & { task_id: string; status: string }>;
    engine_sessions: Record<string, unknown>;
    created_at: number;
    updated_at: number;
  };
}

export interface LocalTeamTaskDispatchInput {
  planId: string;
  ownerSession: LocalSessionRecord;
  task: LocalTeamPlanTask;
  prompt: string;
  modelConfigId?: string;
}

export interface LocalTeamTaskDispatchResult {
  sessionId: string;
  queueItemId?: string;
  agentName?: string;
}

export interface LocalTeamTaskCancelInput {
  sessionId: string;
  queueItemId?: string;
}

export interface LocalTeamTaskCancelResult {
  sessionId: string;
  queueCancelled: boolean;
  turnAborted: boolean;
}

export interface LocalTeamPlanTask {
  id: string;
  title?: string;
  description?: string;
  prompt?: string;
  assignedTo?: string;
  modelConfigId?: string;
  dependsOn: string[];
  raw: Record<string, unknown>;
}

export async function routeLocalTeamApi(input: {
  dataDir: string;
  request: Request;
  method: string;
  parts: string[];
  url: URL;
  nowMs: () => number;
  getSessionById: (sessionId: string) => Promise<LocalSessionRecord | undefined>;
  isTeamDelegationEnabled: (session: LocalSessionRecord) => Promise<boolean>;
  dispatchTeamTask?: (task: LocalTeamTaskDispatchInput) => Promise<LocalTeamTaskDispatchResult>;
  cancelTeamTask?: (task: LocalTeamTaskCancelInput) => Promise<LocalTeamTaskCancelResult>;
}): Promise<Response> {
  const store = new LocalTeamPlanStore(input.dataDir);
  const tail = input.parts.slice(1);
  if (tail[0] === 'verifier-formations' && input.method === 'GET') {
    if (tail.length === 1) return json({ formations: [] });
    return json({ name: tail[1], tasks: [], agents: [] });
  }
  if (tail[0] === 'verifier-cap' && input.method === 'GET') {
    return json({ available: false, cap: null, plan_id: null, task_id: null, cycle: null });
  }
  if (tail[0] !== 'plan') return notFound(`/team/${tail.join('/')}`);

  if (input.method === 'POST' && tail.length === 1) {
    const body = await readJsonBody(input.request);
    const requestedSessionId = readString(body, 'session_id');
    if (!requestedSessionId) return json({ error: 'session_id required' }, { status: 400 });
    const session = await input.getSessionById(requestedSessionId);
    if (!session)
      return json({ error: `Session ${requestedSessionId} not found` }, { status: 404 });
    const delegationGate = await requireTeamDelegation(input, session);
    if (delegationGate) return delegationGate;
    const sessionId = session.sessionId;
    const plan = readObject(body, 'plan');
    if (!plan) return json({ error: 'Invalid plan' }, { status: 400 });
    const tasks = extractPlanTasks(plan);
    const now = input.nowMs();
    const planId = `plan_${randomBytes(4).toString('hex')}`;
    const record: LocalTeamPlanRecord = {
      plan,
      state: {
        plan_id: planId,
        status: 'pending',
        owner_session_id: sessionId,
        owner_agent_name: session.agentName,
        cycle: 0,
        phase: 'pending',
        results: tasks.map((task) => ({
          task_id: task.id,
          status: 'pending',
          attempt: 0,
          producer_agent: task.assignedTo,
        })),
        engine_sessions: {},
        created_at: now,
        updated_at: now,
      },
    };
    await store.write(record);
    return json({ plan_id: planId, state: record.state }, { status: 201 });
  }

  if (input.method === 'GET' && tail.length === 1) {
    const records = await store.list();
    return json({
      plans: records.map((record) => summarizePlan(record)),
    });
  }

  const planId = tail[1];
  if (!planId) return notFound('/team/plan');
  if (!PLAN_ID_PATTERN.test(planId)) return notFound(`/team/plan/${planId}`);
  const record = await store.read(planId);
  if (!record) return json(planNotFoundBody(input.dataDir, planId), { status: 404 });

  if (input.method === 'GET' && tail.length === 2) {
    return json({ state: record.state, plan: record.plan });
  }

  if (input.method === 'DELETE' && tail.length === 2) {
    const access = checkPlanAccess(
      record,
      await canonicalizeSessionId(
        input.getSessionById,
        readCallerSession(input.request, input.url),
      ),
    );
    if (access) return access;
    await store.delete(planId);
    return json({ deleted: true, plan_id: planId });
  }

  if (input.method === 'POST' && tail.length === 3) {
    const body = await readJsonBody(input.request);
    const action = tail[2]!;
    const access = checkPlanAccess(
      record,
      await canonicalizeSessionId(input.getSessionById, readString(body, 'from_session')),
    );
    if (access) return access;
    const now = input.nowMs();
    if (action === 'start') {
      const result = await startLocalTeamPlan({
        record,
        action,
        dataDir: input.dataDir,
        getSessionById: input.getSessionById,
        isTeamDelegationEnabled: input.isTeamDelegationEnabled,
        dispatchTeamTask: input.dispatchTeamTask,
        nowMs: input.nowMs,
      }).catch(localTeamErrorToResponse);
      if (result instanceof Response) return result;
      await store.write(record);
      return json({
        status: 'started',
        plan_id: planId,
        sessions: result.sessions,
      });
    }
    if (action === 'pause') {
      record.state.status = 'paused';
      record.state.phase = 'paused';
    } else if (action === 'resume') {
      const result = await startLocalTeamPlan({
        record,
        action,
        dataDir: input.dataDir,
        getSessionById: input.getSessionById,
        isTeamDelegationEnabled: input.isTeamDelegationEnabled,
        dispatchTeamTask: input.dispatchTeamTask,
        nowMs: input.nowMs,
      }).catch(localTeamErrorToResponse);
      if (result instanceof Response) return result;
      await store.write(record);
      return json({
        status: 'resumed',
        plan_id: planId,
        sessions: result.sessions,
      });
    } else if (action === 'cancel') {
      const result = await cancelLocalTeamPlan({
        record,
        cancelTeamTask: input.cancelTeamTask,
        nowMs: input.nowMs,
      });
      await store.write(record);
      return json({
        status: 'cancelled',
        plan_id: planId,
        cancelled_sessions: result.cancelledSessions,
        failed_sessions: result.failedSessions,
      });
    } else if (action === 'decision') {
      record.state['last_decision'] = body;
    } else if (action === 'steer') {
      record.state['last_steer'] = {
        message: readString(body, 'message') ?? '',
        at: now,
      };
      record.state.phase = 'steered';
    } else {
      return notFound(`/team/plan/${planId}/${action}`);
    }
    record.state.updated_at = now;
    await store.write(record);
    if (action === 'steer') {
      return json({
        status: 'steered',
        plan_id: planId,
        result: {},
        steered_sessions: [],
        failed_sessions: [],
      });
    }
    return json({ status: action, plan_id: planId });
  }

  if (tail[2] === 'tasks' && tail[3]) {
    return routeLocalTeamTaskApi({ ...input, store, record, planId, tail });
  }

  return notFound(`/team/plan/${tail.slice(1).join('/')}`);
}

async function startLocalTeamPlan(input: {
  record: LocalTeamPlanRecord;
  action: 'start' | 'resume' | 'advance';
  dataDir: string;
  getSessionById: (sessionId: string) => Promise<LocalSessionRecord | undefined>;
  isTeamDelegationEnabled: (session: LocalSessionRecord) => Promise<boolean>;
  dispatchTeamTask?: (task: LocalTeamTaskDispatchInput) => Promise<LocalTeamTaskDispatchResult>;
  nowMs: () => number;
}): Promise<{ sessions: Array<{ task_id: string; session_id: string; queue_item_id?: string }> }> {
  const { record } = input;
  if (record.state.status === 'running' && input.action !== 'advance') {
    throw new LocalTeamApiError(
      `Plan ${record.state.plan_id} is already running.`,
      409,
      'LOCAL_TEAM_PLAN_ALREADY_RUNNING',
    );
  }
  if (
    record.state.status !== 'pending' &&
    record.state.status !== 'paused' &&
    record.state.status !== 'failed' &&
    !(input.action === 'advance' && record.state.status === 'running')
  ) {
    throw new LocalTeamApiError(
      `Plan ${record.state.plan_id} cannot be ${input.action}ed from status ${record.state.status}.`,
      409,
      'LOCAL_TEAM_PLAN_NOT_STARTABLE',
    );
  }

  const ownerSession = await input.getSessionById(record.state.owner_session_id);
  if (!ownerSession) {
    throw new LocalTeamApiError(
      `Owner session ${record.state.owner_session_id} not found.`,
      404,
      'LOCAL_TEAM_OWNER_SESSION_NOT_FOUND',
    );
  }
  const teamDelegationEnabled = await input.isTeamDelegationEnabled(ownerSession);
  if (!teamDelegationEnabled && input.action !== 'advance') {
    throw new LocalTeamApiError(
      'Team delegation is disabled for the owner session.',
      403,
      'LOCAL_TEAM_DELEGATION_DISABLED',
    );
  }

  const now = input.nowMs();
  const tasks = extractPlanTasks(record.plan);
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const resultsById = new Map(record.state.results.map((result) => [result.task_id, result]));
  for (const task of tasks) {
    if (!resultsById.has(task.id)) {
      const result = {
        task_id: task.id,
        status: 'pending',
        attempt: 0,
        producer_agent: task.assignedTo,
      };
      record.state.results.push(result);
      resultsById.set(task.id, result);
    }
  }

  const done = new Set(
    record.state.results
      .filter((result) => result.status === 'done')
      .map((result) => result.task_id),
  );
  const maxConcurrency = readPlanMaxConcurrency(record.plan);
  const activeCount = record.state.results.filter(
    (result) => result.status === 'producing' || result.status === 'verifying',
  ).length;
  const allDone =
    record.state.results.length > 0 &&
    record.state.results.every((result) => result.status === 'done');
  if (!teamDelegationEnabled) {
    record.state.status = allDone ? 'completed' : 'paused';
    record.state.phase = allDone ? 'completed' : 'paused';
    delete record.state['blocked_reason'];
    record.state.updated_at = now;
    return { sessions: [] };
  }
  if (!input.dispatchTeamTask) {
    throw new LocalTeamApiError(
      'Local team plan start requires native local-runtime team dispatch support.',
      501,
      'LOCAL_TEAM_ENGINE_UNAVAILABLE',
    );
  }
  let remainingSlots = Math.max(0, maxConcurrency - activeCount);
  const sessions: Array<{ task_id: string; session_id: string; queue_item_id?: string }> = [];
  for (const task of tasks) {
    const result = resultsById.get(task.id);
    if (!result) continue;
    if (
      result.status === 'done' ||
      result.status === 'producing' ||
      result.status === 'verifying' ||
      result.status === 'cancelled'
    ) {
      continue;
    }
    const missingDeps = task.dependsOn.filter((dep) => !done.has(dep) && taskById.has(dep));
    if (missingDeps.length > 0) {
      result.status = 'blocked';
      result['blocked_on'] = missingDeps;
      continue;
    }
    if (remainingSlots <= 0) {
      result.status = 'ready';
      delete result['blocked_on'];
      continue;
    }

    const outputDir = containedPath(
      resolve(input.dataDir, 'plans', record.state.plan_id, 'tasks'),
      task.id,
    );
    await mkdir(outputDir, { recursive: true });
    const dispatch = await input.dispatchTeamTask({
      planId: record.state.plan_id,
      ownerSession,
      task,
      ...(task.modelConfigId || readPlanDefaultModelConfigId(record.plan)
        ? { modelConfigId: task.modelConfigId ?? readPlanDefaultModelConfigId(record.plan) }
        : {}),
      prompt: buildLocalTeamTaskPrompt({
        record,
        task,
        outputPath: join(outputDir, 'deliverable.md'),
      }),
    });
    const agentName = dispatch.agentName ?? task.assignedTo ?? ownerSession.agentName;
    result.status = 'producing';
    result['attempt'] = readAttempt(result) + 1;
    result['producer_agent'] = agentName;
    result['producer_session_id'] = dispatch.sessionId;
    result['started_at'] = now;
    result['queue_item_id'] = dispatch.queueItemId;
    delete result['blocked_on'];
    record.state.engine_sessions[dispatch.sessionId] = {
      task_id: task.id,
      role: 'producer',
      agent_name: agentName,
      spawned_at: now,
      ...(dispatch.queueItemId ? { queue_item_id: dispatch.queueItemId } : {}),
    };
    sessions.push({
      task_id: task.id,
      session_id: dispatch.sessionId,
      ...(dispatch.queueItemId ? { queue_item_id: dispatch.queueItemId } : {}),
    });
    remainingSlots -= 1;
  }

  const hasInFlight = record.state.results.some(
    (result) => result.status === 'producing' || result.status === 'verifying',
  );
  if (sessions.length === 0 && !hasInFlight && !allDone) {
    if (input.action !== 'advance') {
      throw new LocalTeamApiError(
        `Plan ${record.state.plan_id} has no ready local team tasks to dispatch.`,
        409,
        'LOCAL_TEAM_PLAN_NO_READY_TASKS',
      );
    }
    record.state.status = 'failed';
    record.state.phase = 'blocked';
    record.state['blocked_reason'] = 'No ready local team tasks remain to dispatch.';
    record.state.updated_at = now;
    return { sessions };
  }

  record.state.status = allDone ? 'completed' : 'running';
  record.state.phase = allDone ? 'completed' : hasInFlight ? 'produce' : 'blocked';
  delete record.state['blocked_reason'];
  if (!allDone) {
    record.state['cycle_started_at'] = record.state['cycle_started_at'] ?? now;
    record.state.cycle = Math.max(1, record.state.cycle);
  }
  record.state.updated_at = now;
  return { sessions };
}

async function cancelLocalTeamPlan(input: {
  record: LocalTeamPlanRecord;
  cancelTeamTask?: (task: LocalTeamTaskCancelInput) => Promise<LocalTeamTaskCancelResult>;
  nowMs: () => number;
}): Promise<{ cancelledSessions: string[]; failedSessions: string[] }> {
  const now = input.nowMs();
  const cancelledSessions: string[] = [];
  const failedSessions: string[] = [];
  for (const [sessionId, raw] of Object.entries(input.record.state.engine_sessions ?? {})) {
    const sessionInfo = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    try {
      if (input.cancelTeamTask) {
        await input.cancelTeamTask({
          sessionId,
          ...(typeof sessionInfo['queue_item_id'] === 'string'
            ? { queueItemId: sessionInfo['queue_item_id'] as string }
            : {}),
        });
      }
      cancelledSessions.push(sessionId);
    } catch {
      failedSessions.push(sessionId);
    }
  }

  for (const result of input.record.state.results) {
    if (result.status === 'done') continue;
    result.status = 'cancelled';
    result['cancelled_at'] = now;
  }
  input.record.state.status = 'cancelled';
  input.record.state.phase = 'terminal';
  input.record.state.updated_at = now;
  return { cancelledSessions, failedSessions };
}

function buildLocalTeamTaskPrompt(input: {
  record: LocalTeamPlanRecord;
  task: LocalTeamPlanTask;
  outputPath: string;
}): string {
  const planName = readNestedPlanName(input.record.plan) ?? input.record.state.plan_id;
  const taskTitle = input.task.title ?? input.task.id;
  const lines = [
    `You are a local team worker for plan ${input.record.state.plan_id} (${planName}).`,
    `Task ${input.task.id}: ${taskTitle}`,
  ];
  if (input.task.description) lines.push('', input.task.description);
  if (input.task.prompt) lines.push('', input.task.prompt);
  else lines.push('', 'Complete this task and report the result clearly.');
  if (input.task.dependsOn.length > 0) {
    lines.push(
      '',
      `Dependencies already satisfied before dispatch: ${input.task.dependsOn.join(', ')}`,
    );
  }
  const output = input.task.raw['output'];
  if (output && typeof output === 'object') {
    lines.push('', 'Expected output contract:', JSON.stringify(output, null, 2));
  }
  lines.push(
    '',
    `Write the final task deliverable to ${input.outputPath}.`,
    'Also summarize the result in the chat response so the owner can inspect it from the session.',
  );
  return lines.join('\n');
}

function localTeamErrorToResponse(err: unknown): Response {
  if (err instanceof LocalTeamApiError) {
    return json(
      {
        error: err.message,
        code: err.code,
        available: err.status !== 501 && err.code !== 'LOCAL_TEAM_DELEGATION_DISABLED',
      },
      { status: err.status },
    );
  }
  throw err;
}

class LocalTeamApiError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 501,
    readonly code: string,
  ) {
    super(message);
  }
}

async function requireTeamDelegation(
  input: Pick<Parameters<typeof routeLocalTeamApi>[0], 'isTeamDelegationEnabled'>,
  session: LocalSessionRecord,
): Promise<Response | undefined> {
  if (await input.isTeamDelegationEnabled(session)) return undefined;
  return localTeamErrorToResponse(
    new LocalTeamApiError(
      'Team delegation is disabled for the owner session.',
      403,
      'LOCAL_TEAM_DELEGATION_DISABLED',
    ),
  );
}

async function routeLocalTeamTaskApi(input: {
  dataDir: string;
  request: Request;
  method: string;
  parts: string[];
  url: URL;
  nowMs: () => number;
  getSessionById: (sessionId: string) => Promise<LocalSessionRecord | undefined>;
  isTeamDelegationEnabled: (session: LocalSessionRecord) => Promise<boolean>;
  dispatchTeamTask?: (task: LocalTeamTaskDispatchInput) => Promise<LocalTeamTaskDispatchResult>;
  store: LocalTeamPlanStore;
  record: LocalTeamPlanRecord;
  planId: string;
  tail: string[];
}): Promise<Response> {
  const taskId = input.tail[3]!;
  const action = input.tail[4];
  if (!TASK_ID_PATTERN.test(taskId)) {
    return notFound(`/team/plan/${input.planId}/tasks/${taskId}`);
  }
  const result = findTaskResult(input.record, taskId);
  if (!result) return json({ error: `Task ${taskId} not found` }, { status: 404 });

  if (input.method === 'GET' && action === 'deliverable') {
    const tasksDir = resolve(input.dataDir, 'plans', input.planId, 'tasks');
    const outputDir = containedPath(tasksDir, taskId);
    const file = resolve(outputDir, 'deliverable.md');
    if (!isPathInside(outputDir, file))
      return json({ error: 'Invalid deliverable path' }, { status: 400 });
    const tasksDirReal = await realpathIfExists(tasksDir);
    const outputDirReal = await realpathIfExists(outputDir);
    if (!tasksDirReal || !outputDirReal) {
      return json(
        { error: 'Deliverable not produced yet', plan_id: input.planId, task_id: taskId },
        { status: 404 },
      );
    }
    if (!isPathInside(tasksDirReal, outputDirReal)) {
      return json({ error: 'Invalid deliverable path' }, { status: 400 });
    }
    const fileReal = await realpathIfExists(file);
    if (!fileReal) {
      return json(
        { error: 'Deliverable not produced yet', plan_id: input.planId, task_id: taskId },
        { status: 404 },
      );
    }
    if (!isPathInside(outputDirReal, fileReal)) {
      return json({ error: 'Invalid deliverable path' }, { status: 400 });
    }
    try {
      const info = await stat(fileReal);
      const raw = await readFile(fileReal, 'utf-8');
      return json({
        plan_id: input.planId,
        task_id: taskId,
        content: raw.slice(0, 256 * 1024),
        bytes: Math.min(Buffer.byteLength(raw), 256 * 1024),
        truncated: Buffer.byteLength(raw) > 256 * 1024,
        last_modified: info.mtimeMs,
      });
    } catch {
      return json(
        { error: 'Deliverable not produced yet', plan_id: input.planId, task_id: taskId },
        { status: 404 },
      );
    }
  }

  if (input.method !== 'POST') return notFound(`/team/plan/${input.planId}/tasks/${taskId}`);
  const body = await readJsonBody(input.request);
  if (action === 'verdict') {
    return json(
      {
        error:
          'Team verifier verdict requires daemon verifier capabilities and is unavailable in clean local-runtime mode.',
        code: 'LOCAL_TEAM_VERDICT_UNAVAILABLE',
        available: false,
        plan_id: input.planId,
        task_id: taskId,
      },
      { status: 501 },
    );
  }
  const callerSessionId = await canonicalizeSessionId(
    input.getSessionById,
    readString(body, 'from_session'),
  );
  const access =
    action === 'complete'
      ? checkTaskCompletionAccess(input.record, result, callerSessionId)
      : checkPlanAccess(input.record, callerSessionId);
  if (access) return access;
  const now = input.nowMs();

  if (action === 'complete') {
    const tasksDir = resolve(input.dataDir, 'plans', input.planId, 'tasks');
    const outputDir = containedPath(tasksDir, taskId);
    await mkdir(outputDir, { recursive: true });
    const tasksDirReal = await realpathIfExists(tasksDir);
    const outputDirReal = await realpathIfExists(outputDir);
    if (!tasksDirReal || !outputDirReal || !isPathInside(tasksDirReal, outputDirReal)) {
      return json({ error: 'Invalid deliverable path' }, { status: 400 });
    }
    const content =
      readString(body, 'content') ??
      readString(body, 'deliverable') ??
      readString(body, 'deliverable_content');
    const deliverablePath = join(outputDirReal, 'deliverable.md');
    if (content !== undefined) {
      const writeError = await writeTaskDeliverable(outputDirReal, deliverablePath, content);
      if (writeError) return writeError;
    }
    result.status = 'done';
    result['completed_at'] = now;
    result['deliverable_path'] = deliverablePath;
    const summary = readString(body, 'summary');
    if (summary) result['summary'] = summary;
    delete result['blocked_on'];
    input.record.state.updated_at = now;
    await input.store.write(input.record);
    const advance = await startLocalTeamPlan({
      record: input.record,
      action: 'advance',
      dataDir: input.dataDir,
      getSessionById: input.getSessionById,
      isTeamDelegationEnabled: input.isTeamDelegationEnabled,
      dispatchTeamTask: input.dispatchTeamTask,
      nowMs: input.nowMs,
    }).catch(localTeamErrorToResponse);
    if (advance instanceof Response) return advance;
    await input.store.write(input.record);
    return json({
      status: 'completed',
      plan_id: input.planId,
      task_id: taskId,
      plan_status: input.record.state.status,
      sessions: advance.sessions,
    });
  }

  if (action === 'unblock') {
    if (result.status !== 'blocked') {
      return json(
        {
          error: `Task ${taskId} is not blocked`,
          code: 'LOCAL_TEAM_TASK_NOT_BLOCKED',
          plan_id: input.planId,
          task_id: taskId,
          task_status: result.status,
        },
        { status: 409 },
      );
    }
    const previousStatus = result.status;
    result.status = 'ready';
    result['unblocked_at'] = now;
    delete result['blocked_on'];
    input.record.state.updated_at = now;
    await input.store.write(input.record);
    return json({
      status: 'unblocked',
      plan_id: input.planId,
      task_id: taskId,
      previous_status: previousStatus,
      new_status: result.status,
    });
  }
  if (action === 'extend-timeout') {
    const minutes = readNumber(body, 'extra_minutes') ?? readNumber(body, 'minutes') ?? 0;
    const addedMs = Math.max(0, Math.min(minutes * 60 * 1000, 60 * 60 * 1000));
    const previous =
      typeof result['timeout_extended_ms'] === 'number' ? result['timeout_extended_ms'] : 0;
    result['timeout_extended_ms'] = previous + addedMs;
    result['timeout_deadline_at'] = now + addedMs;
    input.record.state.updated_at = now;
    await input.store.write(input.record);
    return json({
      status: 'extended',
      plan_id: input.planId,
      task_id: taskId,
      added_ms: addedMs,
      added_minutes: Math.round(addedMs / 60_000),
      previous_extended_ms: previous,
      new_extended_ms: result['timeout_extended_ms'],
      timeout_deadline_at: result['timeout_deadline_at'],
    });
  }
  if (action === 'verify') {
    result['verify_on'] = body['verify_on'] === true;
    result['verify_skip_reason'] = readString(body, 'reason');
    input.record.state.updated_at = now;
    await input.store.write(input.record);
    return json({
      status: 'updated',
      plan_id: input.planId,
      task_id: taskId,
      verify_on: result['verify_on'],
    });
  }
  return notFound(`/team/plan/${input.planId}/tasks/${taskId}/${action ?? ''}`);
}

class LocalTeamPlanStore {
  private readonly plansDir: string;

  constructor(dataDir: string) {
    this.plansDir = join(dataDir, 'plans');
  }

  async list(): Promise<LocalTeamPlanRecord[]> {
    await mkdir(this.plansDir, { recursive: true });
    const entries = await readdir(this.plansDir, { withFileTypes: true }).catch(() => []);
    const records: LocalTeamPlanRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !PLAN_ID_PATTERN.test(entry.name)) continue;
      const record = await this.read(entry.name);
      if (record) records.push(record);
    }
    return records.sort((a, b) => b.state.updated_at - a.state.updated_at);
  }

  async read(planId: string): Promise<LocalTeamPlanRecord | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.recordPath(planId), 'utf-8')) as unknown;
      if (!parsed || typeof parsed !== 'object') return undefined;
      const record = parsed as LocalTeamPlanRecord;
      // Normalize legacy `phase: "completed"` — old engine wrote `phase: "completed"`
      // but phase should only be a cycle stage (determining/producing/verifying/evaluating).
      // Plan completion is represented by `status: "completed"`, not phase.
      if (record.state.phase === 'completed' && record.state.status === 'completed') {
        record.state.phase = 'evaluating';
      }
      return record;
    } catch {
      return undefined;
    }
  }

  async write(record: LocalTeamPlanRecord): Promise<void> {
    await mkdir(this.planDir(record.state.plan_id), { recursive: true });
    await writeFile(
      this.recordPath(record.state.plan_id),
      `${JSON.stringify(record, null, 2)}\n`,
      'utf-8',
    );
  }

  async delete(planId: string): Promise<void> {
    await rm(this.planDir(planId), { recursive: true, force: true });
  }

  private planDir(planId: string): string {
    if (!PLAN_ID_PATTERN.test(planId)) throw new Error(`Invalid planId: ${planId}`);
    return containedPath(resolve(this.plansDir), planId);
  }

  private recordPath(planId: string): string {
    return join(this.planDir(planId), 'plan.json');
  }
}

/**
 * Active AgentTeam ownership is persisted in the existing plan files. Both
 * the plan's control session and its live worker sessions are automation-owned
 * while the plan is running.
 */
export async function hasActiveLocalTeamOwner(
  dataDir: string,
  sessionId: string,
): Promise<boolean> {
  const records = await new LocalTeamPlanStore(dataDir).list();
  return records.some(
    (record) =>
      record.state.status === 'running' &&
      (record.state.owner_session_id === sessionId ||
        Object.prototype.hasOwnProperty.call(record.state.engine_sessions, sessionId)),
  );
}

function summarizePlan(record: LocalTeamPlanRecord): Record<string, unknown> {
  const results = record.state.results ?? [];
  return {
    plan_id: record.state.plan_id,
    status: record.state.status,
    cycle: record.state.cycle,
    phase: record.state.phase,
    owner_session_id: record.state.owner_session_id,
    total_tasks: results.length,
    tasks_done: results.filter((item) => item.status === 'done').length,
    tasks_remaining: results.filter((item) => item.status !== 'done').length,
    created_at: record.state.created_at,
    updated_at: record.state.updated_at,
  };
}

function extractPlanTasks(plan: Record<string, unknown>): LocalTeamPlanTask[] {
  const tasks = Array.isArray(plan['tasks']) ? plan['tasks'] : [];
  return tasks.flatMap((item, index) => {
    if (!item || typeof item !== 'object') return [];
    const task = item as Record<string, unknown>;
    const assignedTo = readTaskString(task, 'assigned_to');
    const rawId = typeof task['id'] === 'string' && task['id'] ? task['id'] : undefined;
    const dependsOn = Array.isArray(task['depends_on'])
      ? task['depends_on'].filter(
          (value): value is string => typeof value === 'string' && value.length > 0,
        )
      : [];
    return [
      {
        id: rawId && TASK_ID_PATTERN.test(rawId) ? rawId : `task_${String(index + 1)}`,
        ...(readTaskString(task, 'title') ? { title: readTaskString(task, 'title') } : {}),
        ...(readTaskString(task, 'description')
          ? { description: readTaskString(task, 'description') }
          : {}),
        ...(readTaskString(task, 'prompt') ? { prompt: readTaskString(task, 'prompt') } : {}),
        ...(assignedTo ? { assignedTo } : {}),
        ...(readTaskString(task, 'model_config_id')
          ? { modelConfigId: readTaskString(task, 'model_config_id') }
          : {}),
        dependsOn,
        raw: task,
      },
    ];
  });
}

function readPlanDefaultModelConfigId(plan: Record<string, unknown>): string | undefined {
  return (
    readString(plan, 'default_model_config_id') ??
    readString(readObject(plan, 'plan') ?? {}, 'default_model_config_id')
  );
}

function findTaskResult(
  record: LocalTeamPlanRecord,
  taskId: string,
): (Record<string, unknown> & { task_id: string; status: string }) | undefined {
  return record.state.results.find((item) => item.task_id === taskId);
}

function checkPlanAccess(
  record: LocalTeamPlanRecord,
  fromSession: string | undefined,
): Response | undefined {
  if (!fromSession) return json({ error: 'from_session is required' }, { status: 400 });
  if (fromSession !== record.state.owner_session_id) {
    return json(
      { error: 'Access denied: only the plan owner can perform this operation' },
      { status: 403 },
    );
  }
  return undefined;
}

function checkTaskCompletionAccess(
  record: LocalTeamPlanRecord,
  result: Record<string, unknown>,
  fromSession: string | undefined,
): Response | undefined {
  if (!fromSession) return json({ error: 'from_session is required' }, { status: 400 });
  if (
    fromSession === record.state.owner_session_id ||
    fromSession === result['producer_session_id']
  )
    return undefined;
  return json(
    { error: 'Access denied: only the plan owner or producer can complete this task' },
    { status: 403 },
  );
}

function readCallerSession(request: Request, url: URL): string | undefined {
  return (
    url.searchParams.get('from_session') ??
    url.searchParams.get('fromSession') ??
    request.headers.get('X-Mavis-Session') ??
    request.headers.get('x-mavis-session') ??
    undefined
  );
}

async function canonicalizeSessionId(
  getSessionById: (sessionId: string) => Promise<LocalSessionRecord | undefined>,
  sessionId: string | undefined,
): Promise<string | undefined> {
  if (!sessionId) return undefined;
  const session = await getSessionById(sessionId);
  return session?.sessionId ?? sessionId;
}

function planNotFoundBody(dataDir: string, planId: string): Record<string, unknown> {
  return {
    error: `Plan ${planId} not found in local-runtime data dir: ${dataDir}`,
    plan_id: planId,
    profile: 'local-runtime',
    data_dir: dataDir,
  };
}

function containedPath(baseDir: string, child: string): string {
  const resolvedBase = resolve(baseDir);
  const resolvedChild = resolve(resolvedBase, child);
  if (!isPathInside(resolvedBase, resolvedChild)) throw new Error(`Invalid path segment: ${child}`);
  return resolvedChild;
}

function isPathInside(baseDir: string, candidate: string): boolean {
  const rel = relative(resolve(baseDir), resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function realpathIfExists(path: string): Promise<string | undefined> {
  return realpath(path).catch(() => undefined);
}

async function lstatIfExists(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (err) {
    if (err && typeof err === 'object' && (err as { code?: unknown }).code === 'ENOENT') {
      return undefined;
    }
    throw err;
  }
}

async function writeTaskDeliverable(
  outputDirReal: string,
  deliverablePath: string,
  content: string,
): Promise<Response | undefined> {
  const existing = await lstatIfExists(deliverablePath);
  if (existing?.isSymbolicLink()) {
    return json({ error: 'Invalid deliverable path' }, { status: 400 });
  }
  if (existing) {
    const fileReal = await realpathIfExists(deliverablePath);
    if (!fileReal || !isPathInside(outputDirReal, fileReal)) {
      return json({ error: 'Invalid deliverable path' }, { status: 400 });
    }
  }

  const tempPath = join(
    outputDirReal,
    `.deliverable.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );
  try {
    await writeFile(tempPath, content, 'utf-8');
    await rename(tempPath, deliverablePath);
  } catch (err) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw err;
  }

  const writtenReal = await realpathIfExists(deliverablePath);
  if (!writtenReal || !isPathInside(outputDirReal, writtenReal)) {
    await rm(deliverablePath, { force: true }).catch(() => undefined);
    return json({ error: 'Invalid deliverable path' }, { status: 400 });
  }
  return undefined;
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await request.text()) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function readObject(
  body: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = body[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' && value ? value : undefined;
}

function readNumber(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readTaskString(task: Record<string, unknown>, key: string): string | undefined {
  const value = task[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readAttempt(result: Record<string, unknown>): number {
  const value = result['attempt'];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function readPlanMaxConcurrency(plan: Record<string, unknown>): number {
  const nested = plan['plan'];
  const options =
    nested && typeof nested === 'object' && !Array.isArray(nested)
      ? (nested as Record<string, unknown>)
      : plan;
  const value = options['max_concurrency'] ?? options['maxConcurrency'];
  if (typeof value !== 'number' || !Number.isFinite(value)) return Number.MAX_SAFE_INTEGER;
  return Math.max(1, Math.floor(value));
}

function readNestedPlanName(plan: Record<string, unknown>): string | undefined {
  const nested = plan['plan'];
  if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return undefined;
  return readTaskString(nested as Record<string, unknown>, 'name');
}
