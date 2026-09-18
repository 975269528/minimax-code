import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { json, notFound } from '../api/host-helpers.js';

interface SkillEvolveRecord {
  id: string;
  kind: 'signal' | 'proposal';
  status: 'pending' | 'acted' | 'dismissed';
  createdAt: number;
  updatedAt: number;
  body: Record<string, unknown>;
}

interface SkillEvolveState {
  signals: SkillEvolveRecord[];
  proposals: SkillEvolveRecord[];
  history: Array<Record<string, unknown>>;
}

interface SkillEvolveSource {
  channel: string;
  sessionId: string;
  agentName: string;
}

export async function routeLocalSkillEvolveApi(input: {
  dataDir: string;
  request: Request;
  method: string;
  parts: string[];
  url: URL;
  nowMs: () => number;
}): Promise<Response> {
  const store = new LocalSkillEvolveStore(input.dataDir);
  const state = await store.read();
  const tail = input.parts.slice(1);

  if (input.method === 'GET' && tail[0] === 'usage') return json({ usage: {} });

  if (input.method === 'POST' && tail[0] === 'signal') {
    const body = await readJsonBody(input.request);
    const now = input.nowMs();
    const signal: SkillEvolveRecord = {
      id: `sig_${randomBytes(6).toString('hex')}`,
      kind: 'signal',
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      body,
    };
    state.signals.unshift(signal);
    state.history.unshift({ type: 'signal.created', id: signal.id, at: now });
    await store.write(state);
    const serialized = serializeSignal(signal);
    return json({ signal: serialized, signalId: serialized.signalId }, { status: 201 });
  }

  if (input.method === 'POST' && tail.join('/') === 'signal/cancel') {
    const body = await readJsonBody(input.request);
    const signalId = readString(body, 'signalId');
    const signal = state.signals.find((item) => item.id === signalId);
    if (!signal) return json({ error: `Signal ${signalId ?? ''} not found` }, { status: 404 });
    signal.status = 'dismissed';
    signal.updatedAt = input.nowMs();
    signal.body = { ...signal.body, cancelReason: readString(body, 'reason') };
    await store.write(state);
    const serialized = serializeSignal(signal);
    return json({ signal: serialized, signalId: serialized.signalId, status: 'dismissed' });
  }

  if (input.method === 'GET' && tail[0] === 'signals') {
    return json(pageRecords(state.signals, input.url, 'signals', serializeSignal));
  }

  if (input.method === 'POST' && tail.join('/') === 'proposal/cancel') {
    const body = await readJsonBody(input.request);
    const proposalId = readString(body, 'proposalId');
    const proposal = state.proposals.find((item) => item.id === proposalId);
    if (!proposal)
      return json({ error: `Proposal ${proposalId ?? ''} not found` }, { status: 404 });
    proposal.status = 'dismissed';
    proposal.updatedAt = input.nowMs();
    proposal.body = { ...proposal.body, cancelReason: readString(body, 'reason') };
    await store.write(state);
    const serialized = serializeProposal(proposal);
    return json({ proposal: serialized, proposalId: serialized.proposalId, status: 'dismissed' });
  }

  if (input.method === 'POST' && tail.join('/') === 'proposal/mark-acted') {
    const body = await readJsonBody(input.request);
    const proposalId = readString(body, 'proposalId');
    const proposal = state.proposals.find((item) => item.id === proposalId);
    if (!proposal)
      return json({ error: `Proposal ${proposalId ?? ''} not found` }, { status: 404 });
    proposal.status = 'acted';
    proposal.updatedAt = input.nowMs();
    proposal.body = { ...proposal.body, skillRef: readString(body, 'skillRef') };
    await store.write(state);
    const serialized = serializeProposal(proposal);
    return json({ proposal: serialized, proposalId: serialized.proposalId, status: 'acted' });
  }

  if (input.method === 'POST' && tail[0] === 'proposal' && tail.length === 1) {
    const body = await readJsonBody(input.request);
    const now = input.nowMs();
    const proposal: SkillEvolveRecord = {
      id: `pro_${randomBytes(6).toString('hex')}`,
      kind: 'proposal',
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      body,
    };
    state.proposals.unshift(proposal);
    state.history.unshift({ type: 'proposal.created', id: proposal.id, at: now });
    await store.write(state);
    const serialized = serializeProposal(proposal);
    return json({ proposal: serialized, proposalId: serialized.proposalId }, { status: 201 });
  }

  if (input.method === 'GET' && tail[0] === 'proposals') {
    return json(pageRecords(state.proposals, input.url, 'proposals', serializeProposal));
  }

  if (input.method === 'GET' && tail[0] === 'proposal' && tail[1]) {
    const proposal = state.proposals.find((item) => item.id === tail[1]);
    if (!proposal) return json({ error: `Proposal ${tail[1]} not found` }, { status: 404 });
    return json({ proposal: serializeProposal(proposal) });
  }

  if (input.method === 'GET' && tail[0] === 'history') {
    return json(serializeHistory(state, input.url));
  }

  if (input.method === 'POST' && ['trigger', 'scan-request'].includes(tail[0] ?? '')) {
    const body = await readJsonBody(input.request);
    const now = input.nowMs();
    const signal: SkillEvolveRecord = {
      id: `sig_${randomBytes(6).toString('hex')}`,
      kind: 'signal',
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      body: {
        ...body,
        channel: readString(body, 'channel') ?? 'manual',
        issueKind: readString(body, 'issueKind') ?? 'manual-trigger',
        evidenceExcerpt:
          readString(body, 'evidenceExcerpt') ?? 'Manual skill evolution trigger requested.',
      },
    };
    state.signals.unshift(signal);
    state.history.unshift({ type: `skill-evolve.${tail[0]}`, id: signal.id, at: now });
    await store.write(state);
    return json({
      ok: true,
      status: 'queued',
      localRuntime: true,
      signal: serializeSignal(signal),
      decision: null,
    });
  }

  if (input.method === 'POST' && tail[0] === 'revert') {
    const now = input.nowMs();
    state.history.unshift({ type: 'skill-evolve.revert', at: now });
    await store.write(state);
    return json(
      {
        ok: false,
        success: false,
        error: 'Skill archive revert is not implemented by embedded local-runtime.',
        code: 'LOCAL_SKILL_REVERT_UNAVAILABLE',
        localRuntime: true,
      },
      { status: 501 },
    );
  }

  if (input.method === 'POST' && tail[0] === 'lifecycle') {
    const now = input.nowMs();
    state.history.unshift({ type: `skill-evolve.lifecycle.${tail[1] ?? 'unknown'}`, at: now });
    await store.write(state);
    return json(
      {
        ok: false,
        success: false,
        error: 'Skill lifecycle mutations are not implemented by embedded local-runtime.',
        code: 'LOCAL_SKILL_LIFECYCLE_UNAVAILABLE',
        action: tail[1] ?? 'unknown',
        localRuntime: true,
      },
      { status: 501 },
    );
  }

  return notFound(`/skill-evolve/${tail.join('/')}`);
}

class LocalSkillEvolveStore {
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = join(dataDir, 'local-runtime', 'skill-evolve.json');
  }

  async read(): Promise<SkillEvolveState> {
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf-8')) as Partial<SkillEvolveState>;
      return {
        signals: Array.isArray(parsed.signals) ? parsed.signals : [],
        proposals: Array.isArray(parsed.proposals) ? parsed.proposals : [],
        history: Array.isArray(parsed.history) ? parsed.history : [],
      };
    } catch {
      return { signals: [], proposals: [], history: [] };
    }
  }

  async write(state: SkillEvolveState): Promise<void> {
    await mkdir(join(this.file, '..'), { recursive: true });
    await writeFile(this.file, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
  }
}

function pageRecords(
  records: SkillEvolveRecord[],
  url: URL,
  key: 'signals' | 'proposals',
  serialize: (record: SkillEvolveRecord) => Record<string, unknown>,
): Record<string, unknown> {
  const limit = clampInt(url.searchParams.get('limit'), 50, 1, 200);
  const offset = clampInt(url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);
  const filtered = records.filter((item) => matchesFilters(item, url));
  const items = filtered.slice(offset, offset + limit).map(serialize);
  return {
    [key]: items,
    items,
    total: filtered.length,
    has_more: offset + limit < filtered.length,
    next_offset: offset + limit < filtered.length ? offset + limit : null,
  };
}

function serializeHistory(state: SkillEvolveState, url: URL): Record<string, unknown> {
  const skill = url.searchParams.get('skill') ?? '';
  const agent = url.searchParams.get('agent') ?? null;
  const limit = clampInt(url.searchParams.get('limit'), 20, 1, 200);
  const history = state.history.slice(0, limit);
  return {
    skill,
    agent,
    log: history.map(serializeHistoryEntry),
    archives: [],
    history,
    items: history,
  };
}

function serializeHistoryEntry(entry: Record<string, unknown>): Record<string, unknown> {
  const at = typeof entry['at'] === 'number' && Number.isFinite(entry['at']) ? entry['at'] : 0;
  return {
    ts: at,
    action: readString(entry, 'type') ?? 'unknown',
    ...(readString(entry, 'id') ? { runId: readString(entry, 'id') } : {}),
    ...(readString(entry, 'rationale') ? { rationale: readString(entry, 'rationale') } : {}),
  };
}

function serializeSignal(
  record: SkillEvolveRecord,
): Record<string, unknown> & { signalId: string } {
  const issueKind = readString(record.body, 'issueKind') ?? 'other';
  const signal: Record<string, unknown> & { signalId: string } = {
    signalId: record.id,
    createdAt: timestampMs(record.createdAt),
    source: readSource(record.body),
    target: readString(record.body, 'skillRef')
      ? { skillRef: readString(record.body, 'skillRef') }
      : {},
    issueKind,
    evidenceExcerpt:
      readString(record.body, 'evidenceExcerpt') ?? readString(record.body, 'evidence') ?? '',
    verdict: statusToVerdict(record.status),
  };
  const attribution = readString(record.body, 'attribution') ?? inferAttribution(issueKind);
  if (attribution) signal.attribution = attribution;
  const rationale = readString(record.body, 'rationale');
  if (rationale) signal.rationale = rationale;
  if (record.status !== 'pending') signal.actedAt = timestampMs(record.updatedAt);
  const dismissReason =
    readString(record.body, 'cancelReason') ?? readString(record.body, 'dismissReason');
  if (dismissReason) signal.dismissReason = dismissReason;
  return signal;
}

function serializeProposal(
  record: SkillEvolveRecord,
): Record<string, unknown> & { proposalId: string } {
  const proposal: Record<string, unknown> & { proposalId: string } = {
    proposalId: record.id,
    createdAt: timestampMs(record.createdAt),
    source: readSource(record.body),
    suggestedName: readString(record.body, 'suggestedName') ?? '',
    suggestedScope: readString(record.body, 'suggestedScope') ?? 'agent-self',
    summary: readString(record.body, 'summary') ?? '',
    rationale: readString(record.body, 'rationale') ?? '',
    evidenceExcerpts: readStringArray(record.body, 'evidenceExcerpts'),
    verdict: statusToVerdict(record.status),
  };
  const targetAgentName = readString(record.body, 'targetAgentName');
  if (targetAgentName) proposal.targetAgentName = targetAgentName;
  const sketch = readString(record.body, 'sketch');
  if (sketch) proposal.sketch = sketch;
  if (record.status !== 'pending') proposal.actedAt = timestampMs(record.updatedAt);
  const dismissReason =
    readString(record.body, 'cancelReason') ?? readString(record.body, 'dismissReason');
  if (dismissReason) proposal.dismissReason = dismissReason;
  const createdSkillRef =
    readString(record.body, 'skillRef') ?? readString(record.body, 'createdSkillRef');
  if (createdSkillRef) proposal.createdSkillRef = createdSkillRef;
  return proposal;
}

function readSource(body: Record<string, unknown>): SkillEvolveSource {
  return {
    channel: readString(body, 'channel') ?? 'active',
    sessionId: readString(body, 'sessionId') ?? 'unknown',
    agentName: readString(body, 'agentName') ?? 'unknown',
  };
}

function matchesFilters(record: SkillEvolveRecord, url: URL): boolean {
  const verdict = url.searchParams.get('verdict');
  if (verdict && statusToVerdict(record.status) !== verdict) return false;
  const skillRef = url.searchParams.get('skillRef');
  if (skillRef && readString(record.body, 'skillRef') !== skillRef) return false;
  const attribution = url.searchParams.get('attribution');
  if (attribution && readString(record.body, 'attribution') !== attribution) return false;
  const agentName = url.searchParams.get('agentName');
  if (agentName && readSource(record.body).agentName !== agentName) return false;
  const channel = url.searchParams.get('channel');
  if (channel && readSource(record.body).channel !== channel) return false;
  return true;
}

function statusToVerdict(status: SkillEvolveRecord['status']): string {
  if (status === 'acted') return 'acted';
  if (status === 'dismissed') return 'dismissed';
  return 'pending';
}

function inferAttribution(issueKind: string): string | undefined {
  return issueKind === 'missing-step' ||
    issueKind === 'bad-default' ||
    issueKind === 'wrong-trigger'
    ? 'skill_issue'
    : undefined;
}

function readStringArray(body: Record<string, unknown>, key: string): string[] {
  const value = body[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function timestampMs(ms: number): number {
  return Number.isFinite(ms) ? ms : 0;
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

function readString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' && value ? value : undefined;
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const value = raw === null ? fallback : Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}
