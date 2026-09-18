import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import yaml from 'js-yaml';

import { buildLocalChannelBindingKey } from '../../channels/channel-inbound-utils.js';
import type { DatabaseLike } from '../db.js';
import type { AgentNameMapping } from './agent-name-conflict-migration-manifest.js';

export function rewriteKnownYamlFiles(dataDir: string, mappings: AgentNameMapping[]): number {
  const files = [
    'channel-bindings.yaml',
    'feishu-channel.yaml',
    'telegram-channel.yaml',
    'wechat-channel.yaml',
    'channel-routes.yaml',
    'channel-owner.yaml',
    'access-control.yaml',
  ];
  let updated = 0;
  for (const file of files) {
    const filePath = path.join(dataDir, file);
    if (!fs.existsSync(filePath)) continue;
    const raw = fs.readFileSync(filePath, 'utf8');
    let parsed: unknown;
    try {
      parsed = yaml.load(raw);
    } catch {
      throw new Error(`invalid_yaml:${file}`);
    }
    let result: { value: unknown; changed: boolean; count: number };
    if (file === 'channel-bindings.yaml') {
      const bindingResult = rewriteChannelBindingsFile(parsed, mappings);
      result = rewriteYamlMapKeys(
        bindingResult.value,
        mappings,
        new Set(['messageFilters']),
        bindingResult.changed,
        bindingResult.count,
      );
    } else {
      result = rewriteKnownYamlValue(file, parsed, mappings);
    }
    if (!result.changed) continue;
    writeYamlAtomic(filePath, result.value);
    updated += result.count;
  }
  const trackingDir = path.join(dataDir, 'memory', 'tracking');
  if (fs.existsSync(trackingDir)) {
    for (const file of fs.readdirSync(trackingDir)) {
      if (!file.endsWith('.json')) continue;
      const filePath = path.join(trackingDir, file);
      const parsed = parseJsonValueOrThrow(
        fs.readFileSync(filePath, 'utf8'),
        `memory_tracking:${file}`,
      );
      const result = rewriteStructuredValue(parsed, mappings, false);
      if (!result.changed) continue;
      writeJsonAtomic(filePath, result.value);
      updated += result.count;
    }
  }
  return updated;
}

type AffectedPlanFile = {
  planId: string;
  filePath: string;
  value: Record<string, unknown>;
};

export function readAffectedPlanFiles(
  dataDir: string,
  mappings: AgentNameMapping[],
): AffectedPlanFile[] {
  const plansDir = path.join(dataDir, 'plans');
  if (!fs.existsSync(plansDir)) return [];
  const affected: AffectedPlanFile[] = [];
  for (const entry of fs.readdirSync(plansDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const filePath = path.join(plansDir, entry.name, 'plan.json');
    if (!fs.existsSync(filePath)) continue;
    const value = parseJsonValueOrThrow(
      fs.readFileSync(filePath, 'utf8'),
      `plans:${entry.name}/plan.json`,
    );
    if (!isRecord(value)) throw new Error(`invalid_json_record:plans:${entry.name}/plan.json`);
    if (planReferencesAgent(value, mappings)) {
      affected.push({ planId: entry.name, filePath, value });
    }
  }
  return affected;
}

function planReferencesAgent(
  value: Record<string, unknown>,
  mappings: AgentNameMapping[],
): boolean {
  const matches = (candidate: unknown): boolean =>
    typeof candidate === 'string' && mappings.some((mapping) => mapping.from === candidate);
  const tasks = value.tasks;
  if (Array.isArray(tasks) && tasks.some((task) => isRecord(task) && matches(task.assigned_to))) {
    return true;
  }
  const state = value.state;
  if (!isRecord(state)) return false;
  if (matches(state.owner_agent_name)) return true;
  const results = state.results;
  if (
    Array.isArray(results) &&
    results.some((result) => isRecord(result) && matches(result.producer_agent))
  ) {
    return true;
  }
  const engineSessions = state.engine_sessions;
  return (
    isRecord(engineSessions) &&
    Object.values(engineSessions).some(
      (session) => isRecord(session) && matches(session.agent_name),
    )
  );
}

export function rewritePlanFiles(dataDir: string, mappings: AgentNameMapping[]): number {
  let updated = 0;
  for (const plan of readAffectedPlanFiles(dataDir, mappings)) {
    const result = rewritePlanValue(plan.value, mappings);
    if (!result.changed) continue;
    writeJsonAtomic(plan.filePath, result.value);
    updated += result.count;
  }
  return updated;
}

function rewritePlanValue(
  value: Record<string, unknown>,
  mappings: AgentNameMapping[],
): { value: Record<string, unknown>; changed: boolean; count: number } {
  let next: Record<string, unknown> = value;
  let changed = false;
  let count = 0;
  const rewriteField = (record: unknown, field: string): Record<string, unknown> | undefined => {
    if (!isRecord(record) || typeof record[field] !== 'string') return undefined;
    const mapped = mapAgentName(record[field], mappings);
    if (mapped === record[field]) return record;
    changed = true;
    count += 1;
    return { ...record, [field]: mapped };
  };

  const taskValues = value.tasks;
  if (Array.isArray(taskValues)) {
    const tasks = taskValues.map((task) => rewriteField(task, 'assigned_to') ?? task);
    if (tasks.some((task, index) => task !== taskValues[index])) next = { ...next, tasks };
  }
  const state = value.state;
  if (!isRecord(state)) return { value: next, changed, count };
  let nextState = state;
  const owner = rewriteField(state, 'owner_agent_name');
  if (owner && owner !== state) nextState = { ...nextState, ...owner };
  const resultValues = state.results;
  if (Array.isArray(resultValues)) {
    const results = resultValues.map((result) => rewriteField(result, 'producer_agent') ?? result);
    if (results.some((result, index) => result !== resultValues[index])) {
      nextState = { ...nextState, results };
    }
  }
  if (isRecord(state.engine_sessions)) {
    const engineSessions: Record<string, unknown> = {};
    let sessionsChanged = false;
    for (const [sessionId, session] of Object.entries(state.engine_sessions)) {
      const rewritten = rewriteField(session, 'agent_name') ?? session;
      engineSessions[sessionId] = rewritten;
      sessionsChanged = sessionsChanged || rewritten !== session;
    }
    if (sessionsChanged) nextState = { ...nextState, engine_sessions: engineSessions };
  }
  if (nextState !== state) next = { ...next, state: nextState };
  return { value: next, changed, count };
}

function rewriteKnownYamlValue(
  file: string,
  value: unknown,
  mappings: AgentNameMapping[],
): { value: unknown; changed: boolean; count: number } {
  const result = rewriteStructuredValue(value, mappings, false);
  const mapContainers = new Set(
    file === 'access-control.yaml'
      ? ['accessControl']
      : file === 'channel-owner.yaml'
        ? ['owners']
        : ['bindings', 'messageFilters'],
  );
  return rewriteYamlMapKeys(result.value, mappings, mapContainers, result.changed, result.count);
}

function rewriteYamlMapKeys(
  value: unknown,
  mappings: AgentNameMapping[],
  containerKeys: Set<string>,
  changed: boolean,
  count: number,
): { value: unknown; changed: boolean; count: number } {
  if (!isRecord(value)) return { value, changed, count };
  let next = value;
  let nextChanged = changed;
  let nextCount = count;
  for (const containerKey of containerKeys) {
    const container = next[containerKey];
    if (!isRecord(container)) continue;
    const rewritten: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(container)) {
      const nextKey = mapClientName(key, mappings);
      if (Object.hasOwn(rewritten, nextKey)) {
        throw new Error(`structured_reference_key_collision:${nextKey}`);
      }
      rewritten[nextKey] = child;
      if (nextKey !== key) {
        nextChanged = true;
        nextCount += 1;
      }
    }
    if (rewritten !== container) next = { ...next, [containerKey]: rewritten };
  }
  return { value: next, changed: nextChanged, count: nextCount };
}

function rewriteChannelBindingsFile(
  value: unknown,
  mappings: AgentNameMapping[],
): { value: unknown; changed: boolean; count: number } {
  if (!isRecord(value) || !isRecord(value.bindings)) {
    return rewriteStructuredValue(value, mappings, false);
  }
  const result = rewriteStructuredValue(value, mappings, false);
  const root = isRecord(result.value) ? result.value : value;
  const bindings = root.bindings;
  if (!isRecord(bindings)) return result;
  const nextBindings: Record<string, unknown> = {};
  let changed = result.changed;
  let count = result.count;
  for (const [oldKey, rawBinding] of Object.entries(bindings)) {
    if (!isRecord(rawBinding)) {
      nextBindings[oldKey] = rawBinding;
      continue;
    }
    const binding = { ...rawBinding };
    const platform = typeof binding.platform === 'string' ? binding.platform : undefined;
    const clientName = typeof binding.clientName === 'string' ? binding.clientName : undefined;
    const chatId = typeof binding.chatId === 'string' ? binding.chatId : undefined;
    const senderId = typeof binding.senderId === 'string' ? binding.senderId : undefined;
    if (!platform || clientName === undefined || chatId === undefined || senderId === undefined) {
      nextBindings[oldKey] = rawBinding;
      continue;
    }
    const rebuiltKey = buildLocalChannelBindingKey({
      platform: platform as 'feishu' | 'telegram' | 'wechat',
      clientName,
      chatId,
      senderId,
      threadId: typeof binding.threadId === 'string' ? binding.threadId : '',
      lane: typeof binding.lane === 'string' ? binding.lane : 'interactive',
      chatType: '*',
    });
    binding.key = rebuiltKey;
    if (Object.hasOwn(nextBindings, rebuiltKey)) {
      throw new Error(`channel_binding_key_collision:${rebuiltKey}`);
    }
    nextBindings[rebuiltKey] = binding;
    if (rebuiltKey !== oldKey || binding.key !== rawBinding.key) {
      changed = true;
      count += 1;
    }
  }
  return { value: { ...root, bindings: nextBindings }, changed, count };
}

export function rewriteStructuredValue(
  value: unknown,
  mappings: AgentNameMapping[],
  preferenceValue: boolean,
): { value: unknown; changed: boolean; count: number } {
  if (Array.isArray(value)) {
    let changed = false;
    let count = 0;
    const next = value.map((item) => {
      if (preferenceValue && typeof item === 'string') {
        const mapped = mapAgentName(item, mappings);
        if (mapped !== item) {
          changed = true;
          count += 1;
        }
        return mapped;
      }
      const result = rewriteStructuredValue(item, mappings, preferenceValue);
      changed = changed || result.changed;
      count += result.count;
      return result.value;
    });
    return { value: next, changed, count };
  }
  if (!isRecord(value)) return { value, changed: false, count: 0 };
  let changed = false;
  let count = 0;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    let nextChild = child;
    if (
      key === 'agentName' ||
      key === 'agent_name' ||
      key === 'agentId' ||
      key === 'exactOwnerName'
    ) {
      if (typeof child === 'string') {
        nextChild = mapAgentName(child, mappings);
        if (nextChild !== child) {
          changed = true;
          count += 1;
        }
      }
    } else if (key === 'id' && value.type === 'agent' && typeof child === 'string') {
      nextChild = mapAgentName(child, mappings);
      if (nextChild !== child) {
        changed = true;
        count += 1;
      }
    } else if ((key === 'clientName' || key === 'clientId') && typeof child === 'string') {
      nextChild = mapClientName(child, mappings);
      if (nextChild !== child) {
        changed = true;
        count += 1;
      }
    } else if (key === 'purpose' && typeof child === 'string') {
      nextChild = mapCronPurpose(child, mappings);
      if (nextChild !== child) {
        changed = true;
        count += 1;
      }
    } else {
      const result = rewriteStructuredValue(child, mappings, preferenceValue);
      nextChild = result.value;
      changed = changed || result.changed;
      count += result.count;
    }
    next[key] = nextChild;
  }
  return { value: next, changed, count };
}

export function mapAgentName(value: string, mappings: AgentNameMapping[]): string {
  return mappings.find((mapping) => mapping.from === value)?.to ?? value;
}

function mapClientName(value: string, mappings: AgentNameMapping[]): string {
  for (const mapping of mappings) {
    if (value === mapping.from) return mapping.to;
    const aliases = clientAliases(mapping.from);
    const index = aliases.indexOf(value);
    if (index >= 0) return clientAliases(mapping.to)[index] ?? mapping.to;
  }
  return value;
}

function clientAliases(agentName: string): string[] {
  const values = [
    agentName,
    `feishu:${agentName}`,
    `telegram:${agentName}`,
    `wechat:${agentName}`,
    `${agentName}:feishu`,
    `${agentName}:telegram`,
    `${agentName}:wechat`,
  ];
  for (const prefix of ['feishu', 'telegram', 'wechat']) {
    for (const value of [...values]) values.push(`${prefix}:${value}`);
  }
  return [...new Set(values)];
}

function mapCronPurpose(value: string, mappings: AgentNameMapping[]): string {
  for (const mapping of mappings) {
    if (value.startsWith(`cron:${mapping.from}:`)) {
      return `cron:${mapping.to}:${value.slice(`cron:${mapping.from}:`.length)}`;
    }
  }
  return value;
}

export function writeJsonAtomic(filePath: string, value: unknown): void {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, 0o600);
}

function writeYamlAtomic(filePath: string, value: unknown): void {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, yaml.dump(value, { lineWidth: 120, noRefs: true }), 'utf8');
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, 0o600);
}

export function listTables(db: DatabaseLike): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name?: unknown }>
  )
    .map((row) => row.name)
    .filter((name): name is string => typeof name === 'string');
}

export function tableColumns(db: DatabaseLike, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<{ name?: unknown }>)
      .map((row) => row.name)
      .filter((name): name is string => typeof name === 'string'),
  );
}

export function tableExists(db: DatabaseLike, table: string): boolean {
  return listTables(db).includes(table);
}

export function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function parseJsonValueOrThrow(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`invalid_json:${label}`);
  }
}

export function parseJsonOrThrow(value: string, label: string): Record<string, unknown> {
  const parsed = parseJsonValueOrThrow(value, label);
  if (!isRecord(parsed)) throw new Error(`invalid_json_record:${label}`);
  return parsed;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
