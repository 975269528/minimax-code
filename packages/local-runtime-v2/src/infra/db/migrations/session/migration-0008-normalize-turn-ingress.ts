import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import type { MigrationEntry } from '../../migrate.js';

type Database = Parameters<Exclude<MigrationEntry['up'], string>>[0];

export const migration: MigrationEntry = {
  version: 8,
  name: 'normalize_turn_ingress',
  up: normalizeTurnIngress,
};

/**
 * Frozen ingress convergence.
 *
 * The global runner owns the surrounding transaction. Sequence mappings are a repairable
 * projection: corrupt/stale/orphan rows are rebuilt from the receipt table, but a main-table
 * sequence is preserved only when it is a positive safe integer, globally unique, and compatible
 * with the existing mapping for the same turn. Client request values carry durable external
 * identities, so source/capacity/cross-turn conflicts fail closed; only their ordinal projection
 * is rebuilt into a stable, contiguous order.
 */
function normalizeTurnIngress(database: Database): void {
  const ingressRows = readAndValidateIngress(database);
  const descriptorPlan = buildDescriptorPlan(ingressRows);
  const sequencePlan = buildSequencePlan(database, ingressRows);
  const clientRequestPlan = buildClientRequestPlan(database, ingressRows);

  applyDescriptorPlan(database, descriptorPlan);
  applySequencePlan(database, sequencePlan);
  applyClientRequestPlan(database, clientRequestPlan);
  assertPostconditions(database, sequencePlan.historicalHighWater);
}

interface StoredIngressRow {
  readonly turnId: string;
  readonly sessionId: string;
  readonly source: TurnSource;
  readonly clientRequestId: string | null;
  readonly claimId: string | null;
  readonly claimSource: string | null;
  readonly queueItemIdsJson: string | null;
  readonly inputJson: string;
  readonly status: IngressStatus;
  readonly acceptedAtMs: number;
  readonly acceptedSequence: unknown;
  readonly completedAtMs: number | null;
  readonly queueAcknowledgedAtMs: number | null;
  readonly inputDigest: string | null;
  readonly inputMetadataJson: string;
}

type TurnSource = 'send' | 'dispatcher' | 'compaction' | 'rotation';
type IngressStatus = 'accepted' | 'completed' | 'failed' | 'aborted';

interface RawIngressRow {
  readonly turn_id?: unknown;
  readonly session_id?: unknown;
  readonly source?: unknown;
  readonly client_request_id?: unknown;
  readonly claim_id?: unknown;
  readonly claim_source?: unknown;
  readonly queue_item_ids_json?: unknown;
  readonly input_json?: unknown;
  readonly status?: unknown;
  readonly accepted_at_ms?: unknown;
  readonly accepted_sequence?: unknown;
  readonly completed_at_ms?: unknown;
  readonly queue_acknowledged_at_ms?: unknown;
  readonly input_digest?: unknown;
  readonly input_metadata_json?: unknown;
}

function readAndValidateIngress(database: Database): StoredIngressRow[] {
  const rawRows = database
    .prepare(
      `SELECT turn_id, session_id, source, client_request_id,
              claim_id, claim_source, queue_item_ids_json, input_json, status,
              accepted_at_ms, accepted_sequence, completed_at_ms,
              queue_acknowledged_at_ms, input_digest, input_metadata_json
       FROM local_runtime_turn_ingress
       ORDER BY rowid ASC, turn_id ASC`,
    )
    .all() as RawIngressRow[];
  const turnIds = new Set<string>();
  const claimIds = new Set<string>();

  return rawRows.map((row) => {
    const turnId = nonEmptyString(row.turn_id, 'ingress turn identity');
    const sessionId = nonEmptyString(row.session_id, `ingress session identity for ${turnId}`);
    if (turnIds.has(turnId)) throw new Error(`Duplicate ingress turn identity: ${turnId}`);
    turnIds.add(turnId);
    const source = parseSource(row.source, turnId);
    const status = parseStatus(row.status, turnId);
    const clientRequestId = optionalIdentity(
      row.client_request_id,
      `ingress client request identity for ${turnId}`,
    );
    const claimId = optionalIdentity(row.claim_id, `ingress claim identity for ${turnId}`);
    const claimSource = optionalIdentity(row.claim_source, `ingress claim source for ${turnId}`);
    const queueItemIdsJson = optionalString(
      row.queue_item_ids_json,
      `ingress queue item JSON for ${turnId}`,
    );
    validateClaimScope({ turnId, source, claimId, claimSource, queueItemIdsJson });
    if (claimId) {
      if (claimIds.has(claimId)) throw new Error(`Duplicate ingress claim identity: ${claimId}`);
      claimIds.add(claimId);
    }
    const completedAtMs = optionalUnixMs(
      row.completed_at_ms,
      `ingress completed time for ${turnId}`,
    );
    const queueAcknowledgedAtMs = optionalUnixMs(
      row.queue_acknowledged_at_ms,
      `ingress queue acknowledgement time for ${turnId}`,
    );
    validateReceiptLifecycle({
      turnId,
      source,
      status,
      completedAtMs,
      queueAcknowledgedAtMs,
    });

    return {
      turnId,
      sessionId,
      source,
      clientRequestId,
      claimId,
      claimSource,
      queueItemIdsJson,
      inputJson: requiredString(row.input_json, `ingress input JSON for ${turnId}`),
      status,
      acceptedAtMs: unixMs(row.accepted_at_ms, `ingress accepted time for ${turnId}`),
      acceptedSequence: row.accepted_sequence,
      completedAtMs,
      queueAcknowledgedAtMs,
      inputDigest: optionalString(row.input_digest, `ingress input digest for ${turnId}`),
      inputMetadataJson: requiredString(
        row.input_metadata_json,
        `ingress input metadata JSON for ${turnId}`,
      ),
    };
  });
}

function validateReceiptLifecycle(input: {
  readonly turnId: string;
  readonly source: TurnSource;
  readonly status: IngressStatus;
  readonly completedAtMs: number | null;
  readonly queueAcknowledgedAtMs: number | null;
}): void {
  if (input.status === 'accepted') {
    if (input.completedAtMs !== null) {
      throw new Error(`Accepted receipt has a completion time for ${input.turnId}`);
    }
    if (input.source !== 'dispatcher' && input.queueAcknowledgedAtMs !== null) {
      throw new Error(`Non-dispatcher receipt has a queue acknowledgement for ${input.turnId}`);
    }
    return;
  }
  if (input.completedAtMs === null) {
    throw new Error(`Terminal receipt lacks a completion time for ${input.turnId}`);
  }
  if (input.source !== 'dispatcher' || input.queueAcknowledgedAtMs !== null) {
    throw new Error(`Impossible persisted receipt lifecycle for ${input.turnId}`);
  }
}

function parseSource(value: unknown, turnId: string): TurnSource {
  if (
    value === 'send' ||
    value === 'dispatcher' ||
    value === 'compaction' ||
    value === 'rotation'
  ) {
    return value;
  }
  throw new Error(`Invalid ingress source for ${turnId}`);
}

function parseStatus(value: unknown, turnId: string): IngressStatus {
  if (value === 'accepted' || value === 'completed' || value === 'failed' || value === 'aborted') {
    return value;
  }
  throw new Error(`Invalid ingress status for ${turnId}`);
}

interface ClaimScopeInput {
  readonly turnId: string;
  readonly source: TurnSource;
  readonly claimId: string | null;
  readonly claimSource: string | null;
  readonly queueItemIdsJson: string | null;
}

function validateClaimScope(input: ClaimScopeInput): void {
  if (input.source !== 'dispatcher') {
    if (hasClaimScope(input)) throw new Error(`Invalid ingress claim scope for ${input.turnId}`);
    return;
  }
  if (!input.claimId || !input.claimSource || input.queueItemIdsJson === null) {
    throw new Error(`Dispatcher ingress is missing claim identity for ${input.turnId}`);
  }
  validateQueueItemIds(input.queueItemIdsJson, input.turnId);
}

function hasClaimScope(input: ClaimScopeInput): boolean {
  return input.claimId !== null || input.claimSource !== null || input.queueItemIdsJson !== null;
}

function validateQueueItemIds(raw: string, turnId: string): void {
  const itemIds = parseJson(raw, `ingress queue item JSON for ${turnId}`);
  if (
    !Array.isArray(itemIds) ||
    itemIds.length === 0 ||
    itemIds.some((itemId) => typeof itemId !== 'string' || itemId.trim().length === 0) ||
    new Set(itemIds).size !== itemIds.length
  ) {
    throw new Error(`Invalid ingress queue item identities for ${turnId}`);
  }
}

interface InputMetadata {
  readonly contentBytes: number;
  readonly attachmentCount: number;
  readonly queuedMessageCount: number;
  readonly hasModelSelection: boolean;
  readonly hasChannelContext: boolean;
  readonly hasQuotedMessage: boolean;
}

interface InputDescriptor {
  readonly digest: string;
  readonly metadata: InputMetadata;
}

interface DescriptorUpdate extends InputDescriptor {
  readonly turnId: string;
}

function buildDescriptorPlan(rows: readonly StoredIngressRow[]): DescriptorUpdate[] {
  return rows.map((row) => {
    const parsed = parseInput(row.inputJson, row.turnId);
    const computed = describeInput(parsed);
    const existingDigest = parseExistingDigest(row.inputDigest, row.turnId);
    const existingMetadata = parseExistingMetadata(row.inputMetadataJson, row.turnId);
    const alreadyScrubbed = Object.keys(parsed).length === 0;

    if (alreadyScrubbed && existingDigest && existingMetadata) {
      return { turnId: row.turnId, digest: existingDigest, metadata: existingMetadata };
    }
    if (existingDigest && existingDigest !== computed.digest) {
      throw new Error(`Ingress input digest conflicts with input for ${row.turnId}`);
    }
    if (existingMetadata && !sameMetadata(existingMetadata, computed.metadata)) {
      throw new Error(`Ingress input metadata conflicts with input for ${row.turnId}`);
    }
    return { turnId: row.turnId, ...computed };
  });
}

function parseInput(raw: string, turnId: string): Record<string, JsonValue> {
  const value = parseJson(raw, `ingress input for ${turnId}`);
  if (!isPlainRecord(value)) throw new Error(`Ingress input must be a plain object for ${turnId}`);
  assertJsonValue(value, `ingress input for ${turnId}`);
  if ('content' in value && typeof value.content !== 'string') {
    throw new Error(`Ingress input content must be a string for ${turnId}`);
  }
  if ('attachments' in value && !Array.isArray(value.attachments)) {
    throw new Error(`Ingress input attachments must be an array for ${turnId}`);
  }
  if ('queuedMessages' in value && !Array.isArray(value.queuedMessages)) {
    throw new Error(`Ingress input queuedMessages must be an array for ${turnId}`);
  }
  return value as Record<string, JsonValue>;
}

function describeInput(input: Readonly<Record<string, JsonValue>>): InputDescriptor {
  const canonical = JSON.stringify(sortJson(input));
  const attachments = input.attachments as readonly JsonValue[] | undefined;
  const queuedMessages = input.queuedMessages as readonly JsonValue[] | undefined;
  return {
    digest: `sha256:${createHash('sha256').update(canonical).digest('hex')}`,
    metadata: {
      contentBytes: Buffer.byteLength((input.content as string | undefined) ?? '', 'utf8'),
      attachmentCount: attachments?.length ?? 0,
      queuedMessageCount: queuedMessages?.length ?? 0,
      hasModelSelection: input.model !== undefined,
      hasChannelContext: input.channelContext !== undefined,
      hasQuotedMessage: input.quotedMessage !== undefined,
    },
  };
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function assertJsonValue(value: unknown, label: string): asserts value is JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number`);
    return;
  }
  if (Array.isArray(value)) {
    assertJsonArray(value, label);
    return;
  }
  if (!isPlainRecord(value)) throw new Error(`${label} contains a non-plain object`);
  assertJsonRecord(value, label);
}

function assertJsonArray(value: readonly unknown[], label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) throw new Error(`${label} contains a sparse array`);
    assertJsonValue(value[index], label);
  }
}

function assertJsonRecord(value: Readonly<Record<string, unknown>>, label: string): void {
  for (const entry of Object.values(value)) assertJsonValue(entry, label);
}

function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map((entry) => sortJson(entry));
  if (!isPlainRecord(value)) return value;
  const sorted = Object.create(null) as Record<string, JsonValue>;
  for (const key of Object.keys(value).sort()) sorted[key] = sortJson(value[key] as JsonValue);
  return sorted;
}

const METADATA_KEYS = [
  'contentBytes',
  'attachmentCount',
  'queuedMessageCount',
  'hasModelSelection',
  'hasChannelContext',
  'hasQuotedMessage',
] as const;
const SORTED_METADATA_KEYS: readonly string[] = [...METADATA_KEYS].sort();

function parseExistingDigest(raw: string | null, turnId: string): string | undefined {
  if (raw === null || raw.trim().length === 0) return undefined;
  if (!/^sha256:[a-f0-9]{64}$/.test(raw)) {
    throw new Error(`Invalid ingress input digest for ${turnId}`);
  }
  return raw;
}

function parseExistingMetadata(raw: string, turnId: string): InputMetadata | undefined {
  if (raw.trim().length === 0) return undefined;
  const value = parseJson(raw, `ingress input metadata for ${turnId}`);
  if (isPlainRecord(value) && Object.keys(value).length === 0) return undefined;
  if (!isPlainRecord(value)) throw new Error(`Invalid ingress input metadata for ${turnId}`);
  if (!hasExactMetadataShape(value)) {
    throw new Error(`Invalid ingress input metadata for ${turnId}`);
  }
  return {
    contentBytes: value.contentBytes,
    attachmentCount: value.attachmentCount,
    queuedMessageCount: value.queuedMessageCount,
    hasModelSelection: value.hasModelSelection,
    hasChannelContext: value.hasChannelContext,
    hasQuotedMessage: value.hasQuotedMessage,
  };
}

function hasExactMetadataShape(
  value: Readonly<Record<string, unknown>>,
): value is Readonly<Record<string, unknown>> & InputMetadata {
  return hasExactMetadataKeys(value) && hasMetadataCounts(value) && hasMetadataFlags(value);
}

function hasExactMetadataKeys(value: Readonly<Record<string, unknown>>): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === SORTED_METADATA_KEYS.length &&
    keys.every((key, index) => key === SORTED_METADATA_KEYS[index])
  );
}

function hasMetadataCounts(value: Readonly<Record<string, unknown>>): boolean {
  return (
    nonNegativeSafeInteger(value.contentBytes) &&
    nonNegativeSafeInteger(value.attachmentCount) &&
    nonNegativeSafeInteger(value.queuedMessageCount)
  );
}

function hasMetadataFlags(value: Readonly<Record<string, unknown>>): boolean {
  return (
    typeof value.hasModelSelection === 'boolean' &&
    typeof value.hasChannelContext === 'boolean' &&
    typeof value.hasQuotedMessage === 'boolean'
  );
}

function sameMetadata(left: InputMetadata, right: InputMetadata): boolean {
  return METADATA_KEYS.every((key) => left[key] === right[key]);
}

function applyDescriptorPlan(database: Database, plan: readonly DescriptorUpdate[]): void {
  const update = database.prepare(
    `UPDATE local_runtime_turn_ingress
     SET input_json = '{}', input_digest = ?, input_metadata_json = ?
     WHERE turn_id = ?`,
  );
  for (const descriptor of plan) {
    update.run(descriptor.digest, JSON.stringify(descriptor.metadata), descriptor.turnId);
  }
}

interface RawSequenceRow {
  readonly sequence?: unknown;
  readonly turn_id?: unknown;
}

interface SequenceAssignment {
  readonly turnId: string;
  readonly sequence: number;
}

interface SequencePlan {
  readonly assignments: readonly SequenceAssignment[];
  readonly historicalHighWater: number;
}

function buildSequencePlan(
  database: Database,
  ingressRows: readonly StoredIngressRow[],
): SequencePlan {
  const mappingRows = database
    .prepare(
      `SELECT sequence, turn_id
       FROM local_runtime_turn_ingress_sequences
       ORDER BY sequence ASC, turn_id ASC`,
    )
    .all() as RawSequenceRow[];
  const mappings = mappingRows.flatMap((row) => {
    const sequence = row.sequence;
    if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence)) {
      throw new Error('Ingress sequence mapping exceeds the safe integer range');
    }
    if (sequence <= 0) return [];
    return [
      {
        sequence,
        turnId: requiredString(row.turn_id, 'ingress sequence mapping turn identity'),
      },
    ];
  });
  const sqliteHighWater = readSqliteSequence(database);
  assertMainSequenceRange(ingressRows);
  const validMainSequences = ingressRows.flatMap((row) =>
    isPositiveSafeInteger(row.acceptedSequence) ? [row.acceptedSequence] : [],
  );
  const historicalHighWater = maximum(
    [...validMainSequences, ...mappings.map(({ sequence }) => sequence)],
    sqliteHighWater,
  );
  if (historicalHighWater >= Number.MAX_SAFE_INTEGER) {
    throw new Error('Ingress sequence history exhausted the safe integer range');
  }
  const mainCounts = frequency(validMainSequences);
  const mappingByTurn = groupBy(mappings, ({ turnId }) => turnId);
  const mappingBySequence = groupBy(mappings, ({ sequence }) => sequence);
  let nextSequence = historicalHighWater;

  const assignments: SequenceAssignment[] = [];
  for (const row of ingressRows) {
    if (canPreserveSequence(row, mainCounts, mappingByTurn, mappingBySequence)) {
      assignments.push({ turnId: row.turnId, sequence: row.acceptedSequence });
      continue;
    }
    if (nextSequence >= Number.MAX_SAFE_INTEGER) {
      throw new Error('Ingress sequence history exhausted the safe integer range');
    }
    nextSequence += 1;
    assignments.push({ turnId: row.turnId, sequence: nextSequence });
  }

  return { assignments, historicalHighWater };
}

function assertMainSequenceRange(rows: readonly StoredIngressRow[]): void {
  const hasUnsafePositive = rows.some(
    ({ acceptedSequence }) =>
      typeof acceptedSequence === 'number' &&
      acceptedSequence > 0 &&
      !Number.isSafeInteger(acceptedSequence),
  );
  if (hasUnsafePositive) {
    throw new Error('Ingress sequence history exceeds the safe integer range');
  }
}

function canPreserveSequence(
  row: StoredIngressRow,
  mainCounts: ReadonlyMap<number, number>,
  mappingByTurn: ReadonlyMap<string, readonly SequenceAssignment[]>,
  mappingBySequence: ReadonlyMap<number, readonly SequenceAssignment[]>,
): row is StoredIngressRow & { readonly acceptedSequence: number } {
  const candidate = row.acceptedSequence;
  if (!isPositiveSafeInteger(candidate) || mainCounts.get(candidate) !== 1) return false;
  return (
    mappingMatchesTurn(mappingByTurn.get(row.turnId) ?? [], candidate) &&
    mappingMatchesSequence(mappingBySequence.get(candidate) ?? [], row.turnId)
  );
}

function mappingMatchesTurn(mappings: readonly SequenceAssignment[], sequence: number): boolean {
  return mappings.length === 0 || (mappings.length === 1 && mappings[0]?.sequence === sequence);
}

function mappingMatchesSequence(mappings: readonly SequenceAssignment[], turnId: string): boolean {
  return mappings.length === 0 || (mappings.length === 1 && mappings[0]?.turnId === turnId);
}

function readSqliteSequence(database: Database): number {
  const rows = database
    .prepare(
      `SELECT seq
       FROM sqlite_sequence
       WHERE name = 'local_runtime_turn_ingress_sequences'`,
    )
    .all() as Array<{ readonly seq?: unknown }>;
  if (rows.length === 0) return 0;
  if (rows.length !== 1 || !nonNegativeSafeInteger(rows[0]?.seq)) {
    throw new Error('Invalid ingress allocator high-water mark');
  }
  return rows[0].seq;
}

function applySequencePlan(database: Database, plan: SequencePlan): void {
  database.exec(`
    DROP INDEX IF EXISTS idx_local_runtime_turn_ingress_sequence;
    DROP INDEX IF EXISTS local_runtime_turn_ingress_sequences_turn_id;
    UPDATE local_runtime_turn_ingress SET accepted_sequence = NULL;
    DELETE FROM local_runtime_turn_ingress_sequences;
  `);
  const insertMapping = database.prepare(
    `INSERT INTO local_runtime_turn_ingress_sequences(sequence, turn_id)
     VALUES (?, ?)`,
  );
  const updateIngress = database.prepare(
    `UPDATE local_runtime_turn_ingress
     SET accepted_sequence = ?
     WHERE turn_id = ?`,
  );
  for (const assignment of plan.assignments) {
    insertMapping.run(assignment.sequence, assignment.turnId);
    updateIngress.run(assignment.sequence, assignment.turnId);
  }
  const finalHighWater = maximum(
    plan.assignments.map(({ sequence }) => sequence),
    plan.historicalHighWater,
  );
  setSqliteSequence(database, finalHighWater);
  database.exec(`
    CREATE UNIQUE INDEX idx_local_runtime_turn_ingress_sequence
      ON local_runtime_turn_ingress(accepted_sequence)
      WHERE accepted_sequence IS NOT NULL;
    CREATE UNIQUE INDEX local_runtime_turn_ingress_sequences_turn_id
      ON local_runtime_turn_ingress_sequences(turn_id);
  `);
}

function setSqliteSequence(database: Database, highWater: number): void {
  const present = database
    .prepare(
      `SELECT 1 AS present
       FROM sqlite_sequence
       WHERE name = 'local_runtime_turn_ingress_sequences'`,
    )
    .all().length;
  if (present > 0) {
    database
      .prepare(
        `UPDATE sqlite_sequence
         SET seq = ?
         WHERE name = 'local_runtime_turn_ingress_sequences'`,
      )
      .run(highWater);
  } else if (highWater > 0) {
    database
      .prepare(`INSERT INTO sqlite_sequence(name, seq) VALUES (?, ?)`)
      .run('local_runtime_turn_ingress_sequences', highWater);
  }
}

interface ClientRequestMapping {
  readonly sessionId: string;
  readonly clientRequestId: string;
  readonly turnId: string;
  ordinal: number;
}

interface RawClientRequestRow {
  readonly session_id?: unknown;
  readonly client_request_id?: unknown;
  readonly turn_id?: unknown;
  readonly ordinal?: unknown;
}

function buildClientRequestPlan(
  database: Database,
  ingressRows: readonly StoredIngressRow[],
): ClientRequestMapping[] {
  const ingressByTurn = new Map(ingressRows.map((row) => [row.turnId, row]));
  const mappings = readClientRequestMappings(database, ingressByTurn);
  assertUniqueClientIdentities(mappings);
  assertUniquePrimaryClientRequests(ingressRows);
  assertPrimaryMappingOwnership(ingressRows, mappings);
  const mappingsByTurn = groupBy(mappings, ({ turnId }) => turnId);
  const normalized: ClientRequestMapping[] = [];
  for (const ingress of ingressRows) {
    normalized.push(
      ...normalizeTurnClientRequests(ingress, mappingsByTurn.get(ingress.turnId) ?? []),
    );
  }
  assertUniqueClientIdentities(normalized);
  return normalized.sort(compareClientRequestMappings);
}

function readClientRequestMappings(
  database: Database,
  ingressByTurn: ReadonlyMap<string, StoredIngressRow>,
): ClientRequestMapping[] {
  const rawRows = database
    .prepare(
      `SELECT session_id, client_request_id, turn_id, ordinal
       FROM local_runtime_turn_ingress_client_requests
       ORDER BY turn_id ASC, ordinal ASC, client_request_id ASC`,
    )
    .all() as RawClientRequestRow[];
  return rawRows.map((row) => parseClientRequestMapping(row, ingressByTurn));
}

function parseClientRequestMapping(
  row: RawClientRequestRow,
  ingressByTurn: ReadonlyMap<string, StoredIngressRow>,
): ClientRequestMapping {
  const turnId = nonEmptyString(row.turn_id, 'client request mapping turn identity');
  const ingress = ingressByTurn.get(turnId);
  if (!ingress) throw new Error(`Client request mapping references missing turn: ${turnId}`);
  const sessionId = nonEmptyString(
    row.session_id,
    `client request mapping session identity for ${turnId}`,
  );
  if (sessionId !== ingress.sessionId) {
    throw new Error(`Client request mapping session conflicts with turn ${turnId}`);
  }
  return {
    sessionId,
    clientRequestId: nonEmptyString(row.client_request_id, `client request identity for ${turnId}`),
    turnId,
    ordinal: nonNegativeSafeIntegerRequired(row.ordinal, `client request ordinal for ${turnId}`),
  };
}

function assertUniquePrimaryClientRequests(ingressRows: readonly StoredIngressRow[]): void {
  const primaryByIdentity = new Map<string, string>();
  for (const row of ingressRows) {
    if (!row.clientRequestId) continue;
    const identity = clientIdentity(row.sessionId, row.clientRequestId);
    const existingTurn = primaryByIdentity.get(identity);
    if (existingTurn && existingTurn !== row.turnId) {
      throw new Error(`Client request identity conflicts across turns: ${row.clientRequestId}`);
    }
    primaryByIdentity.set(identity, row.turnId);
  }
}

function assertPrimaryMappingOwnership(
  ingressRows: readonly StoredIngressRow[],
  mappings: readonly ClientRequestMapping[],
): void {
  const mappingByIdentity = new Map(
    mappings.map((mapping) => [
      clientIdentity(mapping.sessionId, mapping.clientRequestId),
      mapping,
    ]),
  );
  for (const ingress of ingressRows) {
    if (!ingress.clientRequestId) continue;
    const mapping = mappingByIdentity.get(
      clientIdentity(ingress.sessionId, ingress.clientRequestId),
    );
    if (mapping && mapping.turnId !== ingress.turnId) {
      throw new Error(`Client request identity maps to another turn: ${ingress.clientRequestId}`);
    }
  }
}

function normalizeTurnClientRequests(
  ingress: StoredIngressRow,
  existing: readonly ClientRequestMapping[],
): ClientRequestMapping[] {
  const ordered = [...existing].sort(compareExistingClientRequestOrder);
  assertSourceAwareIdentityContract(ingress, ordered);
  const primary = findPrimaryClientRequest(ingress, ordered) ?? createPrimaryClientRequest(ingress);
  const finalOrder = primary
    ? [primary, ...ordered.filter((mapping) => mapping !== primary)]
    : ordered;
  return finalOrder.map((mapping, ordinal) => ({ ...mapping, ordinal }));
}

function assertSourceAwareIdentityContract(
  ingress: StoredIngressRow,
  mappings: readonly ClientRequestMapping[],
): void {
  if (ingress.source !== 'dispatcher') {
    assertDirectIdentityContract(ingress, mappings);
    return;
  }
  const hasPrimary = findPrimaryClientRequest(ingress, mappings) !== undefined;
  const normalizedCount = mappings.length + (ingress.clientRequestId && !hasPrimary ? 1 : 0);
  const queueItemCount = readQueueItemIds(ingress).length;
  if (normalizedCount > queueItemCount) {
    throw new Error(`Dispatcher durable identity count exceeds queue items for ${ingress.turnId}`);
  }
}

function assertDirectIdentityContract(
  ingress: StoredIngressRow,
  mappings: readonly ClientRequestMapping[],
): void {
  if (!ingress.clientRequestId) {
    if (mappings.length > 0) {
      throw new Error(`Non-dispatcher receipt has an extra durable identity for ${ingress.turnId}`);
    }
    return;
  }
  if (
    mappings.length > 1 ||
    (mappings.length === 1 && mappings[0]?.clientRequestId !== ingress.clientRequestId)
  ) {
    throw new Error(`Non-dispatcher client request identity conflicts for ${ingress.turnId}`);
  }
}

function findPrimaryClientRequest(
  ingress: StoredIngressRow,
  mappings: readonly ClientRequestMapping[],
): ClientRequestMapping | undefined {
  if (!ingress.clientRequestId) return undefined;
  return mappings.find(
    ({ sessionId, clientRequestId }) =>
      sessionId === ingress.sessionId && clientRequestId === ingress.clientRequestId,
  );
}

function createPrimaryClientRequest(ingress: StoredIngressRow): ClientRequestMapping | undefined {
  if (!ingress.clientRequestId) return undefined;
  return {
    sessionId: ingress.sessionId,
    clientRequestId: ingress.clientRequestId,
    turnId: ingress.turnId,
    ordinal: 0,
  };
}

function readQueueItemIds(ingress: StoredIngressRow): readonly unknown[] {
  if (ingress.queueItemIdsJson === null) {
    throw new Error(`Dispatcher ingress lacks queue item identities for ${ingress.turnId}`);
  }
  const value = parseJson(
    ingress.queueItemIdsJson,
    `ingress queue item JSON for ${ingress.turnId}`,
  );
  if (!Array.isArray(value)) throw new Error(`Invalid queue item identities for ${ingress.turnId}`);
  return value;
}

function compareExistingClientRequestOrder(
  left: ClientRequestMapping,
  right: ClientRequestMapping,
): number {
  return (
    left.ordinal - right.ordinal || compareStrings(left.clientRequestId, right.clientRequestId)
  );
}

function compareClientRequestMappings(
  left: ClientRequestMapping,
  right: ClientRequestMapping,
): number {
  return (
    compareStrings(left.turnId, right.turnId) ||
    left.ordinal - right.ordinal ||
    compareStrings(left.clientRequestId, right.clientRequestId)
  );
}

function assertUniqueClientIdentities(mappings: readonly ClientRequestMapping[]): void {
  const identities = new Set<string>();
  for (const mapping of mappings) {
    const identity = clientIdentity(mapping.sessionId, mapping.clientRequestId);
    if (identities.has(identity)) {
      throw new Error(`Duplicate client request identity: ${mapping.clientRequestId}`);
    }
    identities.add(identity);
  }
}

function applyClientRequestPlan(
  database: Database,
  mappings: readonly ClientRequestMapping[],
): void {
  database.exec('DELETE FROM local_runtime_turn_ingress_client_requests;');
  const insert = database.prepare(
    `INSERT INTO local_runtime_turn_ingress_client_requests(
       session_id, client_request_id, turn_id, ordinal
     ) VALUES (?, ?, ?, ?)`,
  );
  for (const mapping of mappings) {
    insert.run(mapping.sessionId, mapping.clientRequestId, mapping.turnId, mapping.ordinal);
  }
}

function assertPostconditions(database: Database, historicalHighWater: number): void {
  const rows = readAndValidateIngress(database);
  const sequenceByTurn = readSequencePostconditions(database, rows.length);
  const assigned = assertIngressPostconditions(rows, sequenceByTurn);
  assertAllocatorPostcondition(database, historicalHighWater, assigned);
  assertClientRequestPostconditions(database, rows);
}

function readSequencePostconditions(
  database: Database,
  ingressCount: number,
): ReadonlyMap<string, number> {
  const sequences = database
    .prepare(
      `SELECT sequence, turn_id
       FROM local_runtime_turn_ingress_sequences
       ORDER BY sequence ASC`,
    )
    .all() as RawSequenceRow[];
  if (sequences.length !== ingressCount)
    throw new Error('Ingress sequence projection is incomplete');
  const sequenceByTurn = new Map<string, number>();
  for (const raw of sequences) {
    const sequence = positiveSafeInteger(raw.sequence, 'ingress sequence postcondition');
    const turnId = nonEmptyString(raw.turn_id, 'ingress sequence postcondition turn');
    if (sequenceByTurn.has(turnId))
      throw new Error('Ingress sequence projection is not one-to-one');
    sequenceByTurn.set(turnId, sequence);
  }
  return sequenceByTurn;
}

function assertIngressPostconditions(
  rows: readonly StoredIngressRow[],
  sequenceByTurn: ReadonlyMap<string, number>,
): ReadonlySet<number> {
  const assigned = new Set<number>();
  for (const row of rows) {
    assertIngressSequencePostcondition(row, sequenceByTurn, assigned);
    assertIngressDescriptorPostcondition(row);
  }
  return assigned;
}

function assertIngressSequencePostcondition(
  row: StoredIngressRow,
  sequenceByTurn: ReadonlyMap<string, number>,
  assigned: Set<number>,
): void {
  if (!isPositiveSafeInteger(row.acceptedSequence)) {
    throw new Error(`Ingress sequence is invalid for ${row.turnId}`);
  }
  if (assigned.has(row.acceptedSequence)) throw new Error('Ingress sequences are not unique');
  assigned.add(row.acceptedSequence);
  if (sequenceByTurn.get(row.turnId) !== row.acceptedSequence) {
    throw new Error(`Ingress sequence projection conflicts for ${row.turnId}`);
  }
}

function assertIngressDescriptorPostcondition(row: StoredIngressRow): void {
  if (row.inputJson !== '{}') throw new Error(`Ingress input was not scrubbed for ${row.turnId}`);
  parseExistingDigest(row.inputDigest, row.turnId);
  if (!parseExistingMetadata(row.inputMetadataJson, row.turnId)) {
    throw new Error(`Ingress input metadata is missing for ${row.turnId}`);
  }
}

function assertAllocatorPostcondition(
  database: Database,
  historicalHighWater: number,
  assigned: ReadonlySet<number>,
): void {
  const maxAssigned = maximum(assigned, 0);
  if (readSqliteSequence(database) < Math.max(historicalHighWater, maxAssigned)) {
    throw new Error('Ingress allocator high-water mark regressed');
  }
}

function assertClientRequestPostconditions(
  database: Database,
  ingressRows: readonly StoredIngressRow[],
): void {
  const ingressByTurn = new Map(ingressRows.map((row) => [row.turnId, row]));
  const mappings = readClientRequestMappings(database, ingressByTurn);
  assertUniqueClientIdentities(mappings);
  const mappingsByTurn = groupBy(mappings, ({ turnId }) => turnId);
  for (const ingress of ingressRows) {
    const turnMappings = mappingsByTurn.get(ingress.turnId) ?? [];
    assertSourceAwareIdentityContract(ingress, turnMappings);
    assertContinuousClientRequestOrdinals(ingress.turnId, turnMappings);
    if (ingress.clientRequestId && turnMappings[0]?.clientRequestId !== ingress.clientRequestId) {
      throw new Error(`Primary client request mapping is incomplete for ${ingress.turnId}`);
    }
  }
}

function assertContinuousClientRequestOrdinals(
  turnId: string,
  mappings: readonly ClientRequestMapping[],
): void {
  const ordered = [...mappings].sort(compareClientRequestMappings);
  if (ordered.some(({ ordinal }, index) => ordinal !== index)) {
    throw new Error(`Client request ordinals are not continuous for ${turnId}`);
  }
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`Invalid ${label} JSON`, { cause: error });
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  return value;
}

function nonEmptyString(value: unknown, label: string): string {
  const parsed = requiredString(value, label);
  if (parsed.trim().length === 0) throw new Error(`${label} must be non-empty`);
  return parsed;
}

function optionalString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return requiredString(value, label);
}

function optionalIdentity(value: unknown, label: string): string | null {
  if (value === null) return null;
  return nonEmptyString(value, label);
}

function unixMs(value: unknown, label: string): number {
  if (!nonNegativeSafeInteger(value)) throw new Error(`${label} must be a Unix ms integer`);
  return value;
}

function optionalUnixMs(value: unknown, label: string): number | null {
  if (value === null) return null;
  return unixMs(value, label);
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (!isPositiveSafeInteger(value)) throw new Error(`${label} must be a positive safe integer`);
  return value;
}

function nonNegativeSafeIntegerRequired(value: unknown, label: string): number {
  if (!nonNegativeSafeInteger(value)) throw new Error(`${label} must be a non-negative integer`);
  return value;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function frequency(values: readonly number[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function maximum(values: Iterable<number>, initial: number): number {
  let result = initial;
  for (const value of values) {
    if (value > result) result = value;
  }
  return result;
}

function groupBy<T, K>(values: readonly T[], keyOf: (value: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const value of values) {
    const key = keyOf(value);
    const group = groups.get(key);
    if (group) group.push(value);
    else groups.set(key, [value]);
  }
  return groups;
}

function clientIdentity(sessionId: string, clientRequestId: string): string {
  return JSON.stringify([sessionId, clientRequestId]);
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
