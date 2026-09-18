import type { TuiStreamEvent } from '../../../runtime/stream-events.js';
import { countTokens as countO200kBase } from 'gpt-tokenizer/model/gpt-4o';

interface OutputSample {
  startedAtMs?: number;
  finishedAtMs?: number;
  outputTokens?: number;
  requestDurationMs?: number;
  estimatedOutputTokens?: number;
  pendingOutput?: string[];
  observedAtMs?: number;
}

export interface TuiTurnOutputRateOptions {
  readonly now?: () => number;
  readonly livePublishIntervalMs?: number;
}

const DEFAULT_LIVE_PUBLISH_INTERVAL_MS = 250;

/**
 * Derives current-turn output throughput in two phases: live deltas publish a batched BPE token
 * estimate, then Runtime-authoritative provider usage replaces it when available. Tool wall-clock
 * time is excluded by ending each sample at its finish chunk instead of the later durable message,
 * which may be deferred until tool execution ends.
 */
export class TuiTurnOutputRate {
  private turnId: string | undefined;
  private readonly samples = new Map<string, OutputSample>();
  private value: number | undefined;
  private estimated: boolean | undefined;
  private lastPublishedAtMs: number | undefined;
  private readonly now: () => number;
  private readonly livePublishIntervalMs: number;

  constructor(options: TuiTurnOutputRateOptions = {}) {
    this.now = options.now ?? Date.now;
    this.livePublishIntervalMs = Math.max(
      0,
      options.livePublishIntervalMs ?? DEFAULT_LIVE_PUBLISH_INTERVAL_MS,
    );
  }

  beginTurn(turnId: string): void {
    this.turnId = turnId;
    this.samples.clear();
    this.value = undefined;
    this.estimated = undefined;
    this.lastPublishedAtMs = undefined;
  }

  apply(turnId: string, event: TuiStreamEvent): number | undefined {
    if (turnId !== this.turnId) return this.value;
    let forcePublish = false;
    let rateInputChanged = false;
    if (event.type === 'delta' && event.messageId) {
      rateInputChanged = true;
      const sample = this.sample(event.messageId);
      const timestamp = finiteTimestamp(event.timestamp);
      if (
        timestamp !== undefined &&
        sample.startedAtMs === undefined &&
        (event.started === true || event.content !== undefined || event.thinking !== undefined)
      ) {
        sample.startedAtMs = timestamp;
      }
      this.appendPendingOutput(sample, event.content);
      this.appendPendingOutput(sample, event.thinking);
      if (timestamp !== undefined) sample.observedAtMs = timestamp;
      if (event.finish === true && timestamp !== undefined) sample.finishedAtMs = timestamp;
      forcePublish = event.finish === true;
    } else if (event.type === 'message' && event.message.role === 'assistant' && event.message.id) {
      rateInputChanged = true;
      const sample = this.sample(event.message.id);
      const outputTokens = positiveFinite(event.message.usage?.outputTokens);
      if (outputTokens !== undefined) sample.outputTokens = outputTokens;
      const requestDurationMs = positiveFinite(event.message.usage?.requestDurationMs);
      if (requestDurationMs !== undefined) sample.requestDurationMs = requestDurationMs;
      if (sample.finishedAtMs === undefined) {
        sample.finishedAtMs = finiteTimestamp(event.message.timestamp);
      }
      forcePublish = true;
    }
    if (!rateInputChanged) return this.value;
    const nowMs = this.now();
    if (!forcePublish && this.lastPublishedAtMs === undefined) {
      this.lastPublishedAtMs = nowMs;
      return this.value;
    }
    const elapsedMs = nowMs - (this.lastPublishedAtMs ?? nowMs);
    if (!forcePublish && elapsedMs >= 0 && elapsedMs < this.livePublishIntervalMs) {
      return this.value;
    }
    this.lastPublishedAtMs = nowMs;
    return this.publishMeasurement();
  }

  finalize(): number | undefined {
    return this.publishMeasurement();
  }

  private publishMeasurement(): number | undefined {
    this.flushPendingOutput();
    const measurement = this.calculate();
    this.value = measurement?.tokensPerSecond;
    this.estimated = measurement?.estimated;
    return this.value;
  }

  current(): number | undefined {
    return this.value;
  }

  currentEstimated(): boolean | undefined {
    return this.estimated;
  }

  reset(): void {
    this.turnId = undefined;
    this.samples.clear();
    this.value = undefined;
    this.estimated = undefined;
    this.lastPublishedAtMs = undefined;
  }

  private sample(messageId: string): OutputSample {
    const existing = this.samples.get(messageId);
    if (existing) return existing;
    const created: OutputSample = {};
    this.samples.set(messageId, created);
    return created;
  }

  private appendPendingOutput(sample: OutputSample, value: string | undefined): void {
    if (!value) return;
    (sample.pendingOutput ??= []).push(value);
  }

  private flushPendingOutput(): void {
    for (const sample of this.samples.values()) {
      if (!sample.pendingOutput || sample.pendingOutput.length === 0) continue;
      const estimatedTokens = estimateOutputTokens(sample.pendingOutput.join(''));
      sample.pendingOutput = undefined;
      if (estimatedTokens > 0) {
        sample.estimatedOutputTokens = (sample.estimatedOutputTokens ?? 0) + estimatedTokens;
      }
    }
  }

  private calculate(): { tokensPerSecond: number; estimated: boolean } | undefined {
    let outputTokens = 0;
    let generationDurationMs = 0;
    let estimated = false;
    for (const sample of this.samples.values()) {
      if (sample.outputTokens !== undefined && sample.requestDurationMs !== undefined) {
        outputTokens += sample.outputTokens;
        generationDurationMs += sample.requestDurationMs;
        continue;
      }
      const sampleTokens = sample.estimatedOutputTokens;
      const sampleFinishedAtMs = sample.finishedAtMs ?? sample.observedAtMs;
      if (
        sampleTokens === undefined ||
        sample.startedAtMs === undefined ||
        sampleFinishedAtMs === undefined
      )
        continue;
      const durationMs = sampleFinishedAtMs - sample.startedAtMs;
      if (!Number.isFinite(durationMs) || durationMs <= 0) continue;
      outputTokens += sampleTokens;
      generationDurationMs += durationMs;
      estimated = true;
    }
    if (outputTokens <= 0 || generationDurationMs <= 0) return undefined;
    const rate = outputTokens / (generationDurationMs / 1_000);
    return Number.isFinite(rate) && rate > 0 ? { tokensPerSecond: rate, estimated } : undefined;
  }
}

function estimateOutputTokens(value: string | undefined): number {
  if (!value) return 0;
  try {
    const tokens = countO200kBase(value, { allowedSpecial: 'all' });
    if (Number.isFinite(tokens) && tokens >= 0) return tokens;
  } catch {
    // Fall through to the bounded CJK-aware estimate. Throughput is advisory until provider usage.
  }
  let cjk = 0;
  let other = 0;
  for (const character of value) {
    if (CJK_CHARACTER.test(character)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

const CJK_CHARACTER =
  /[\u{3000}-\u{303F}\u{3040}-\u{30FF}\u{3400}-\u{4DBF}\u{4E00}-\u{9FFF}\u{F900}-\u{FAFF}\u{FF00}-\u{FFEF}\u{AC00}-\u{D7AF}\u{20000}-\u{2FA1F}]/u;

function finiteTimestamp(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function positiveFinite(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}
