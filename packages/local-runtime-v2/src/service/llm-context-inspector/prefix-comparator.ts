/**
 * How one captured Call's context relates to the previous successful Call of the
 * same Session.
 *
 * `EPOCH_START` means a prefix comparison would be meaningless because the
 * provider starts a fresh cache entry regardless of the context bytes.
 * `NOT_COMPARABLE` means the comparison was declined for lack of a trustworthy
 * request body; it is never a guess about the relation.
 */
export type PrefixRelation =
  | 'EPOCH_START'
  | 'IDENTICAL'
  | 'APPEND_ONLY'
  | 'DIVERGED'
  | 'NOT_COMPARABLE';

/** Why a Call opens a new cache epoch instead of extending the previous prefix. */
export type EpochReason =
  | 'SESSION_START'
  | 'PROVIDER_CHANGED'
  | 'MODEL_CHANGED'
  | 'API_CHANGED'
  | 'CAPTURE_RESUMED'
  | 'CACHE_POLICY_CHANGED';

export interface ComparableCall {
  readonly callId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly apiId: string;
  readonly captureEpoch: number;
  /** Raw captured provider request body. May be absent or invalid JSON. */
  readonly requestJson?: string | undefined;
}

export interface PrefixComparison {
  readonly relation: PrefixRelation;
  /** Set exactly when a prefix comparison was actually performed. */
  readonly baselineCallId?: string;
  /** RFC 6901 JSON Pointer, DIVERGED only. */
  readonly firstDifferencePointer?: string;
  readonly epochReason?: EpochReason;
}

type JsonObject = Record<string, unknown>;

/**
 * The provider serialises context in this order, so the first reported difference
 * must follow it too: a stale tool definition invalidates the whole prefix and
 * has to outrank any later message difference.
 */
/**
 * Breakpoint markers are excluded from the content comparison. They ride along
 * with the context but say nothing about it, and moving one is already reported
 * through the cache-policy fingerprint, so comparing them twice would surface a
 * spurious context divergence.
 */
const CACHE_CONTROL_KEY = 'cache_control';

/**
 * Classify a captured Call against the previous successful Call of its Session.
 *
 * Pure: the result depends only on the two arguments, and neither is mutated.
 */
export function compareContextPrefix(
  current: ComparableCall,
  baseline: ComparableCall | undefined,
): PrefixComparison {
  if (baseline === undefined) return epochStart('SESSION_START');

  // Decided before the bodies are read at all: another endpoint or another model
  // cannot hit the previous prefix cache, so the context bytes stop mattering.
  // This is also why an epoch is still reported when a body is unavailable.
  if (current.providerId !== baseline.providerId) return epochStart('PROVIDER_CHANGED');
  if (current.modelId !== baseline.modelId) return epochStart('MODEL_CHANGED');
  if (current.apiId !== baseline.apiId) return epochStart('API_CHANGED');
  if (current.captureEpoch !== baseline.captureEpoch) return epochStart('CAPTURE_RESUMED');

  const currentContext = parseRequestBody(current.apiId, current.requestJson);
  const baselineContext = parseRequestBody(baseline.apiId, baseline.requestJson);
  if (currentContext === undefined || baselineContext === undefined) {
    return { relation: 'NOT_COMPARABLE' };
  }

  // Breakpoints decide what the provider was asked to retain, so a policy change
  // opens a new epoch even when every byte of context is preserved.
  if (cachePolicyFingerprint(currentContext) !== cachePolicyFingerprint(baselineContext)) {
    return epochStart('CACHE_POLICY_CHANGED');
  }

  return compareContextContent(currentContext, baselineContext, baseline.callId);
}

function epochStart(epochReason: EpochReason): PrefixComparison {
  return { relation: 'EPOCH_START', epochReason };
}

/**
 * Parse a captured body into a comparable context.
 *
 * A body that is absent, malformed, or not a JSON object carries no locatable
 * `tools` / `system` / `messages`, and a guessed relation would be worse than
 * admitting the gap.
 */
interface ComparableContext {
  readonly root: JsonObject;
  readonly stable: readonly { readonly name: string; readonly value: unknown }[];
  readonly sequence: { readonly name: string; readonly value: unknown };
}

function parseRequestBody(
  apiId: string,
  requestJson: string | undefined,
): ComparableContext | undefined {
  if (requestJson === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(requestJson);
    if (!isJsonObject(parsed)) return undefined;
    switch (apiId) {
      case 'anthropic-messages':
        return projectMessageContext(parsed, true);
      case 'openai-completions':
        return projectMessageContext(parsed, false);
      case 'openai-responses':
      case 'openai-codex-responses':
        return projectResponsesContext(parsed);
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

function projectMessageContext(
  parsed: JsonObject,
  includeSystem: boolean,
): ComparableContext | undefined {
  if (!Array.isArray(parsed.messages)) return undefined;
  const stable = [{ name: 'tools', value: parsed.tools }];
  if (includeSystem) stable.push({ name: 'system', value: parsed.system });
  return {
    root: parsed,
    stable,
    sequence: { name: 'messages', value: parsed.messages },
  };
}

function projectResponsesContext(parsed: JsonObject): ComparableContext | undefined {
  if (!Array.isArray(parsed.input)) return undefined;
  return {
    root: parsed,
    stable: [
      { name: 'tools', value: parsed.tools },
      { name: 'instructions', value: parsed.instructions },
    ],
    sequence: { name: 'input', value: parsed.input },
  };
}

function compareContextContent(
  currentContext: ComparableContext,
  baselineContext: ComparableContext,
  baselineCallId: string,
): PrefixComparison {
  for (let index = 0; index < currentContext.stable.length; index += 1) {
    const section = currentContext.stable[index];
    const baselineSection = baselineContext.stable[index];
    if (!section || !baselineSection || section.name !== baselineSection.name) {
      return { relation: 'NOT_COMPARABLE' };
    }
    const pointer = firstDifference(section.value, baselineSection.value, `/${section.name}`);
    if (pointer !== undefined) return diverged(baselineCallId, pointer);
  }
  if (currentContext.sequence.name !== baselineContext.sequence.name) {
    return { relation: 'NOT_COMPARABLE' };
  }
  return compareSequence(
    currentContext.sequence.value,
    baselineContext.sequence.value,
    baselineCallId,
    `/${currentContext.sequence.name}`,
  );
}

function compareSequence(
  current: unknown,
  baseline: unknown,
  baselineCallId: string,
  pointerRoot: string,
): PrefixComparison {
  if (!Array.isArray(current) || !Array.isArray(baseline)) {
    return { relation: 'NOT_COMPARABLE' };
  }

  const shared = Math.min(current.length, baseline.length);
  for (let index = 0; index < shared; index += 1) {
    const pointer = firstDifference(current[index], baseline[index], `${pointerRoot}/${index}`);
    if (pointer !== undefined) return diverged(baselineCallId, pointer);
  }

  if (current.length === baseline.length) return { relation: 'IDENTICAL', baselineCallId };
  // Dropping a retained message — compaction, an edit, a rewind — breaks the
  // cached prefix even though everything that survived still matches.
  if (current.length < baseline.length) {
    return diverged(baselineCallId, `${pointerRoot}/${current.length}`);
  }
  return { relation: 'APPEND_ONLY', baselineCallId };
}

function diverged(baselineCallId: string, firstDifferencePointer: string): PrefixComparison {
  return { relation: 'DIVERGED', baselineCallId, firstDifferencePointer };
}

/**
 * First structural difference between two context nodes, as an RFC 6901 pointer,
 * or `undefined` when they are equivalent.
 *
 * Object keys are visited in sorted order so the reported pointer never depends
 * on serialisation order, and comparison stops at the first difference so a
 * large diverging context is not walked to the end.
 */
function firstDifference(current: unknown, baseline: unknown, pointer: string): string | undefined {
  if (current === baseline) return undefined;

  if (Array.isArray(current) && Array.isArray(baseline)) {
    const shared = Math.min(current.length, baseline.length);
    for (let index = 0; index < shared; index += 1) {
      const found = firstDifference(current[index], baseline[index], `${pointer}/${index}`);
      if (found !== undefined) return found;
    }
    return current.length === baseline.length ? undefined : `${pointer}/${shared}`;
  }

  if (isJsonObject(current) && isJsonObject(baseline)) {
    return firstObjectDifference(current, baseline, pointer);
  }

  // Differing primitives, or a shape change such as a plain `system` string
  // against an array of blocks: the node itself is the difference.
  return pointer;
}

function firstObjectDifference(
  current: JsonObject,
  baseline: JsonObject,
  pointer: string,
): string | undefined {
  const currentKeys = comparableKeys(current);
  const baselineKeys = comparableKeys(baseline);

  for (const key of currentKeys) {
    const childPointer = `${pointer}/${escapePointerToken(key)}`;
    if (!Object.hasOwn(baseline, key)) return childPointer;
    const found = firstDifference(current[key], baseline[key], childPointer);
    if (found !== undefined) return found;
  }

  for (const key of baselineKeys) {
    if (!Object.hasOwn(current, key)) return `${pointer}/${escapePointerToken(key)}`;
  }
  return undefined;
}

function comparableKeys(value: JsonObject): string[] {
  return Object.keys(value)
    .filter((key) => key !== CACHE_CONTROL_KEY)
    .sort();
}

/** RFC 6901 requires `~` and `/` to be escaped inside a reference token. */
function escapePointerToken(token: string): string {
  return token.replaceAll('~', '~0').replaceAll('/', '~1');
}

/**
 * Fingerprint of the cache breakpoints a request declares.
 *
 * Per section it records how many breakpoints exist and what each one asks for,
 * as an order-independent multiset. Position is deliberately excluded: the usual
 * cache-friendly pattern moves the trailing breakpoint onto each newly appended
 * message, and treating that as a policy change would hide every append behind a
 * new epoch. A different count, a different section, or a different `ttl` is a
 * real policy change and does alter the fingerprint.
 */
function cachePolicyFingerprint(context: ComparableContext): string {
  const sections = [...context.stable, context.sequence];
  const fingerprints = sections.map((section) => {
    const sectionBreakpoints: string[] = [];
    collectCacheBreakpoints(section.value, sectionBreakpoints);
    return `${section.name}:[${sectionBreakpoints.sort().join(',')}]`;
  });
  fingerprints.push(`prompt_cache_key:${stableStringify(context.root.prompt_cache_key)}`);
  fingerprints.push(
    `prompt_cache_retention:${stableStringify(context.root.prompt_cache_retention)}`,
  );
  return fingerprints.join(';');
}

function collectCacheBreakpoints(value: unknown, out: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectCacheBreakpoints(item, out);
    return;
  }
  if (!isJsonObject(value)) return;

  if (Object.hasOwn(value, CACHE_CONTROL_KEY)) {
    out.push(stableStringify(value[CACHE_CONTROL_KEY]));
  }
  for (const key of Object.keys(value)) {
    if (key !== CACHE_CONTROL_KEY) collectCacheBreakpoints(value[key], out);
  }
}

/** Order-independent rendering of one breakpoint marker, `ttl` included. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isJsonObject(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
