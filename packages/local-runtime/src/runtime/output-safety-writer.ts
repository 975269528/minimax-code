import type { PiEventWriter } from '@mavis/agent-core/pi-turn-runner';
import { RespDataType } from '@mavis/agent-core/protocol/agent-message';
import { RuntimeEventStatus, RuntimeEventType, type IRuntimeEvent } from '@mavis/protocol';

import { reviewBlocks, SAFETY_SCENE, type SafetyScene } from '../content-safety/api.js';
import {
  defaultOutputSafetyLocalErrorRetryDelay,
  OUTPUT_SAFETY_CHUNK_THRESHOLD,
  OUTPUT_SAFETY_LOCAL_ERROR_MAX_RETRIES,
  type LocalOutputSafetyDeps,
} from './output-safety-deps.js';
import { OutputSafetyV2GuideState } from './output-safety-v2-guide-state.js';
import { parseStreamResp, type PendingEvent } from './output-safety-pending-event.js';
import { flushApprovedOnNetworkStop } from './output-safety-flush-approved.js';

export {
  OUTPUT_SAFETY_CHUNK_THRESHOLD,
  OUTPUT_SAFETY_LOCAL_ERROR_MAX_RETRIES,
  OUTPUT_SAFETY_LOCAL_ERROR_RETRY_MAX_DELAY_MS,
  type LocalOutputSafetyDeps,
} from './output-safety-deps.js';

/**
 * Output-review event writer: The local review-before-release boundary.
 *
 * agent-core continuously emits stream.resp containing user-visible text/thinking chunks and
 * nontext chunks such as finish/tool-call. Text requires safety review; nontext does not, but must
 * retain producer order in SSE instead of overtaking earlier text.
 *
 * Maintain one pendingQueue:
 * 1. Enqueue every stream.resp in agent-core producer order.
 * 2. Mark text/thinking unreleasable until its review window passes.
 * 3. finish / first tool-call marks a streaming phase boundary: settle the remaining short text
 *   window before making that boundary chunk releasable. Other nontext chunks simply wait in the
 *   queue.
 * 4. Review the complete final AgentMessage again, then release its event in original order.
 *
 * The goal is to preserve agent-core's chunk_index / producer order for upstream SSE while never
 * leaking unapproved content to the UI.
 *
 * Both failure exits set flags and discard unsent content without throwing: pi's event loop
 * swallows writer exceptions, so throwing cannot reliably drive follow-up behavior.
 * - Content verdict rejected → set {@link blocked}; the host retracts and regenerates.
 * - Safety API local_error retries exhausted → set {@link networkStopped}; the host preserves
 *   approved content and shows a network notice without retracting user input.
 * The host reads both flags after runTurn resolves; these are the reliable blocking signals.
 */
export class LocalOutputSafetyEventWriter implements PiEventWriter {
  /** Whether output safety review blocked the current attempt; read by the host after runTurn ends. */
  blocked = false;
  /** V2 hard rejection or auth failure must not enter the regeneration loop. */
  immediateBlock = false;
  // Delegate V2 guide review state to a separate state class to stay within the 500-line layout budget.
  private readonly v2GuideState = new OutputSafetyV2GuideState();

  /** An explicit V2 Review supplied a model-only instruction for the next attempt. */
  get guideReviewed(): boolean {
    return this.v2GuideState.isGuideReviewed();
  }
  /**
   * Whether the current attempt soft-stopped after exhausting consecutive safety API local_error
   * retries.
   *
   * Unlike {@link blocked}, local_error indicates a network/API failure, not a content verdict.
   * Preserve already-approved, flushed content; discard only the unapproved window, whose verdict
   * may never arrive. Abort the generating pi turn without regeneration. The host must not retract
   * the whole turn or the user-input bubble; only show a network notice above the input.
   */
  networkStopped = false;
  /** A runtime FAILED terminal observed after this attempt soft-stopped. */
  terminalFailed = false;

  /**
   * Snapshot of approved, flushed thinking/content prefixes. After a network soft stop, the host
   * rewrites the pi-history assistant message to include only these prefixes. onHistoryChangedHook
   * persists pi's full output, including unapproved tails; without cleanup, the next turn would
   * feed unseen, unapproved content to the model.
   */
  getApprovedPartial(): { thinking: string; content: string; msgId: string | undefined } {
    return {
      thinking: this.approvedThinking,
      content: this.approvedContent,
      msgId: this.approvedMsgId,
    };
  }

  private readonly inner: PiEventWriter;
  private readonly deps: LocalOutputSafetyDeps;
  private readonly threshold: number;
  private readonly localErrorMaxRetries: number;
  private readonly retryDelay: () => Promise<void>;

  /**
   * V2: Consume the latest matched guide_prompt (model guidance from V2 SafetyCheckV2.Action=Guide)
   * and clear state. Return undefined if absent; the host should fall back to fixed
   * OUTPUT_REVISION_INSTRUCTION text.
   */
  consumeGuidePrompt(): string | undefined {
    return this.v2GuideState.consume();
  }

  /** V2: Reset guide review state once per attempt boundary, called by the host. */
  resetGuideReview(): void {
    this.v2GuideState.reset();
  }
  /**
   * Queue all stream.resp events not yet written upstream here.
   *
   * Do not split thinking/content/finish into separately flushed queues. The bug arose when frames
   * without reviewable text (finish or tool-call deltas) were considered immediately sendable and
   * bypassed earlier text/thinking still awaiting review, producing out-of-order SSE.
   *
   * The unified queue conservatively flushes only a consecutive releasable=true prefix. Even safe
   * later events must wait for earlier ones to become safe.
   */
  private readonly pendingQueue: PendingEvent[] = [];
  /**
   * References to pending events in the current thinking review window. Passing review marks them
   * releasable in pendingQueue without moving the events themselves.
   */
  private readonly thinkingWindow: PendingEvent[] = [];
  /**
   * References to pending events in the current content review window. Review content and thinking
   * separately because they use different SafetyScene values.
   */
  private readonly contentWindow: PendingEvent[] = [];
  /** Accumulated text in the current thinking sliding window; review at threshold, phase boundary, or final. */
  private thinkingText = '';
  /** Accumulated text in the current content sliding window; review at threshold, phase boundary, or final. */
  private contentText = '';
  /**
   * Full accumulated thinking/content that has passed review (releaseWindow completed).
   *
   * On a soft stop after local_error retries are exhausted, synthesize a final AgentMessage
   * containing only approved text and forward it to the sink for host observeFrame persistence. The
   * local path only persists final AgentMessage events; without this, a soft stop leaves approved
   * thinking/content as transient stream fragments lost on refetch/rewind.
   */
  private approvedThinking = '';
  private approvedContent = '';
  /**
   * Most recently observed assistant msg_id, shared by chunks and final events for one message.
   * Reuse it for the synthetic soft-stop message so persistence/streaming merge with
   * already-displayed chunks.
   */
  private approvedMsgId: string | undefined;

  constructor(inner: PiEventWriter, deps: LocalOutputSafetyDeps) {
    this.inner = inner;
    this.deps = deps;
    this.threshold = deps.chunkThreshold ?? OUTPUT_SAFETY_CHUNK_THRESHOLD;
    this.localErrorMaxRetries = deps.localErrorMaxRetries ?? OUTPUT_SAFETY_LOCAL_ERROR_MAX_RETRIES;
    this.retryDelay = deps.retryDelay ?? defaultOutputSafetyLocalErrorRetryDelay;
  }

  async pushRuntime(event: IRuntimeEvent): Promise<void> {
    // Once this attempt is blocked by content review or soft-stopped by exhausted network retries, discard all later events.
    // The host owns subsequent terminal/retry behavior; do not release leftover events
    // from the old attempt here.
    if (this.blocked) return;
    if (this.networkStopped) {
      // The soft-stop normally drops every residual producer event. A FAILED
      // terminal is different: it records that the runner itself failed, so it
      // must remain authoritative over the host's synthetic network COMPLETED.
      if (
        event.type === RuntimeEventType.SESSION_STATUS &&
        event.payload?.status === RuntimeEventStatus.FAILED
      ) {
        this.terminalFailed = true;
        await this.inner.pushRuntime(event);
      }
      return;
    }

    // Non-STREAM_RESP control frames (session.status, debug traces, internal terminal states) do not participate
    // in browser SSE chunk ordering and may pass through immediately. Otherwise, a below-threshold text chunk
    // stuck in the queue after abort could prevent the host from ever receiving terminal status.
    if (event.type !== RuntimeEventType.STREAM_RESP) {
      await this.inner.pushRuntime(event);
      return;
    }
    const resp = parseStreamResp(event);
    if (!resp) {
      // An unparseable stream_resp has no reviewable text but still participates in SSE ordering;
      // mark it ready and let the unified queue decide when to release it.
      await this.enqueueReady(event);
      return;
    }

    if (resp.type === RespDataType.AgentMessageChunk && resp.agent_message_chunk) {
      const chunk = resp.agent_message_chunk;
      if (typeof chunk.msg_id === 'string' && chunk.msg_id) this.approvedMsgId = chunk.msg_id;
      if (chunk.thinking_content) {
        // Enqueue thinking text as unreleasable. Only after its thinking review window passes
        // does releaseWindow mark the pending events releasable.
        const pending = this.enqueuePending(event);
        this.thinkingWindow.push(pending);
        this.thinkingText += chunk.thinking_content;
        if (this.thinkingText.length >= this.threshold) {
          await this.flushStreamingWindow('thinking');
        }
        return;
      }
      if (chunk.msg_content) {
        // agent-core guarantees the transition from thinking to content is irreversible; the first content chunk
        // ends the thinking phase. Settle any below-threshold thinking tail first so a short thinking prefix
        // cannot hold back approved content until the final event.
        if (!(await this.flushStreamingWindow('thinking'))) return;
        // Content text works like thinking but uses the StreamChunk scene for sliding-window review.
        // Do not call appendEvents directly here, or safety review and producer ordering would be bypassed.
        const pending = this.enqueuePending(event);
        this.contentWindow.push(pending);
        this.contentText += chunk.msg_content;
        if (this.contentText.length >= this.threshold) {
          await this.flushStreamingWindow('content');
        }
        return;
      }
      // Nontext chunks, commonly tool-call or finish deltas, need no content review.
      // finish corresponds to the producer's message_end; the first tool-call also marks a phase boundary
      // for producers without an earlier finish. Both must settle short thinking/content tails first,
      // without waiting for the full AgentMessage, which arrives only at tool_execution_end when tools are present.
      if (chunk.finish === true || (chunk.tool_calls?.length ?? 0) > 0) {
        if (!(await this.flushStreamingWindows())) return;
      }
      // Enqueue the current ready frame only after boundary review passes; review rejection or network soft-stop
      // has already cleared pendingQueue in the helper. Return directly, never bypassing unapproved text.
      await this.enqueueReady(event);
      return;
    }

    if (resp.type === RespDataType.AgentMessage && resp.agent_message) {
      // The final complete message contains the full agent output for this turn.
      //
      // Sliding windows guarantee safety only within each window and may miss cross-window combinations. On final,
      // review complete thinking and content again. Only after final review passes may held chunks
      // and the final event be released to upstream SSE in their original pendingQueue order.
      const message = resp.agent_message;
      if (typeof message.msg_id === 'string' && message.msg_id) this.approvedMsgId = message.msg_id;
      if (
        !(await this.reviewFinalWindow(
          message.thinking_content,
          this.thinkingText,
          SAFETY_SCENE.ThinkingContent,
        ))
      ) {
        return;
      }
      // Final thinking review covers the full text (reviewFinalWindow prefers completeText).
      // Set the full text directly to avoid double-counting streamed windows; fall back to the accumulated tail
      // if final lacks complete text. If content review then soft-stops, approvedThinking already holds all thinking.
      this.approvedThinking =
        message.thinking_content && message.thinking_content.length > 0
          ? message.thinking_content
          : this.approvedThinking + this.thinkingText;
      this.releaseWindow(this.thinkingWindow);
      this.thinkingText = '';
      await this.flushReady();
      if (
        !(await this.reviewFinalWindow(
          message.msg_content,
          this.contentText,
          SAFETY_SCENE.MessageOutput,
        ))
      ) {
        return;
      }
      this.approvedContent =
        message.msg_content && message.msg_content.length > 0
          ? message.msg_content
          : this.approvedContent + this.contentText;
      this.releaseWindow(this.contentWindow);
      this.contentText = '';
      await this.enqueueReady(event);
      return;
    }

    // Other STREAM_RESP events without message payloads also lack reviewable text, but still use the queue
    // to preserve producer order relative to surrounding chunks.
    await this.enqueueReady(event);
  }

  async appendEvents(events: IRuntimeEvent[]): Promise<void> {
    for (const event of events) await this.pushRuntime(event);
  }

  /**
   * Only approved windows (including api_error degradation) may be released.
   * Guide retains a model-only prompt but aborts and drops this attempt just
   * like Reject. Transport failures retry the same text, then soft-stop.
   */
  private async review(text: string, scene: SafetyScene): Promise<boolean> {
    if (!text.trim()) return true;
    const metrics = this.deps.metricsClient;
    let retryScene = scene;
    // 1 initial call + up to localErrorMaxRetries re-submissions of the SAME text.
    for (let attempt = 0; attempt <= this.localErrorMaxRetries; attempt += 1) {
      if (this.blocked || this.networkStopped) return false;
      const startMs = Date.now();
      const result = await this.deps.checkText(text, retryScene);
      // A concurrent input verdict may have retired this attempt while review was pending.
      if (this.blocked || this.networkStopped) return false;
      metrics?.histogram('output_safety_check_duration_ms', Date.now() - startMs);
      if (result.errorKind === 'local_error') {
        if (result.retryWithV2 && retryScene === SAFETY_SCENE.StreamChunk) {
          retryScene = SAFETY_SCENE.MessageOutput;
        }
        metrics?.counter('output_safety_error_total', 1, { errorKind: 'local_error' });
        // Network/API failure, not a content verdict. While retries remain, wait a random 0–5s backoff and retry
        // the same text; jitter avoids overloading an unavailable gateway and staggers concurrent turns.
        if (attempt < this.localErrorMaxRetries) {
          metrics?.counter('output_safety_check_total', 1, { decision: 'local_error' });
          await this.retryDelay();
          continue;
        }
        // Retries exhausted without a verdict: soft-stop and preserve approved content without retracting it.
        metrics?.counter('output_safety_check_total', 1, { decision: 'soft_stop_network' });
        await this.softStopNetwork();
        return false;
      }
      if (result.errorKind === 'api_error') {
        metrics?.counter('output_safety_error_total', 1, { errorKind: 'api_error' });
      }
      // A definitive verdict (rejected / api_error / pass) uses the shared failure policy.
      // rejected fails closed (retract + regenerate); api_error degrades to allow.
      if (reviewBlocks(result)) {
        if (result.action === 'reject' || result.errorKind === 'auth_error') {
          this.immediateBlock = true;
          this.block();
          return false;
        }
        // Preserve the guide for the next attempt without releasing this draft.
        if (
          result.action === 'guide' &&
          typeof result.guide_prompt === 'string' &&
          result.guide_prompt.trim()
        ) {
          this.v2GuideState.mark(result.guide_prompt);
          metrics?.counter('output_safety_check_total', 1, { decision: 'guide_review' });
          this.block();
          return false;
        }
        metrics?.counter('output_safety_check_total', 1, { decision: 'block' });
        metrics?.counter('output_safety_block_total', 1);
        this.block();
        return false;
      }
      metrics?.counter('output_safety_check_total', 1, { decision: 'pass' });
      return true;
    }
    // The loop should never reach here because all branches return; fall back to a soft stop.
    await this.softStopNetwork();
    return false;
  }

  /**
   * Mark the current attempt blocked.
   *
   * Set blocked so subsequent pushRuntime calls silently drop events; clear all unsent pending
   * content, which may contain rejected text and must never flush; call onBlocked so the host
   * aborts the generating agent-core turn. Both this class's output review and the host's
   * asynchronous input-review rejection use this path, requiring that the current attempt leak
   * nothing further to the UI.
   */
  block(): void {
    if (this.blocked) return;
    this.blocked = true;
    // Discard unsent content: it may contain rejected text and must not remain for later flushing.
    this.pendingQueue.length = 0;
    this.thinkingWindow.length = 0;
    this.contentWindow.length = 0;
    this.thinkingText = '';
    this.contentText = '';
    this.deps.onBlocked?.();
  }

  /**
   * Soft-stop the current attempt after output safety API local_error retries are exhausted.
   *
   * Differs from {@link block} only in its semantic flag (networkStopped rather than blocked),
   * directing the host to preserve approved content, show a network notice, and retain user input
   * instead of retracting and regenerating. Side effects are the same: set networkStopped to
   * silently drop later events; clear pending unflushed content with no verdict (approved flushed
   * content remains); call onBlocked so the host aborts the generating pi turn.
   */
  async softStopNetwork(): Promise<void> {
    if (this.blocked || this.networkStopped) return;
    this.networkStopped = true;
    // First synthesize a final AgentMessage containing approved portions and forward it to the inner sink,
    // triggering host observeFrame persistence. The local path persists assistant messages only on final
    // AgentMessage events. A soft stop prevents the original final event reaching the sink; without this extra
    // event, approved thinking/content remains transient and is lost on refetch/rewind. Skip if nothing is approved.
    await this.flushApprovedOnNetworkStop();
    // Discard unsent content without a verdict; already-flushed approved content is unaffected.
    this.pendingQueue.length = 0;
    this.thinkingWindow.length = 0;
    this.contentWindow.length = 0;
    this.thinkingText = '';
    this.contentText = '';
    this.deps.onBlocked?.();
  }

  /**
   * On soft stop, emit a final AgentMessage containing only approved thinking/content so
   * persistence (observeFrame → upsertDisplayMessage) commits it. Reuse the turn's approvedMsgId to
   * merge with already-displayed chunks via msg_id upsert.
   */
  private async flushApprovedOnNetworkStop(): Promise<void> {
    return flushApprovedOnNetworkStop(this);
  }

  private enqueuePending(event: IRuntimeEvent): PendingEvent {
    // "Pending" means the event occupies its producer-order position but has not passed review.
    const pending = { event, releasable: false };
    this.pendingQueue.push(pending);
    return pending;
  }

  private async enqueueReady(event: IRuntimeEvent): Promise<void> {
    if (this.blocked || this.networkStopped) return;
    // "Ready" means the event needs no review or is already safe, but preceding pending events may still block it.
    const pending = { event, releasable: true };
    this.pendingQueue.push(pending);
    await this.flushReady();
  }

  /**
   * Settle all streaming text windows still below threshold.
   *
   * Thinking must precede content to preserve producer order and prevent content and the current
   * finish/tool-call from entering the ready queue if thinking is rejected. Return false on any
   * rejection or network soft stop; callers must stop processing the current frame.
   */
  private async flushStreamingWindows(): Promise<boolean> {
    if (!(await this.flushStreamingWindow('thinking'))) return false;
    return this.flushStreamingWindow('content');
  }

  /**
   * Review and release a streaming window. Threshold, thinking→content, finish, and tool-call
   * boundaries share this path so branches do not separately maintain approved snapshots, window
   * references, and ready prefixes.
   */
  private async flushStreamingWindow(kind: 'thinking' | 'content'): Promise<boolean> {
    const thinking = kind === 'thinking';
    const text = thinking ? this.thinkingText : this.contentText;
    if (text.length === 0) return true;
    const scene = thinking ? SAFETY_SCENE.ThinkingContent : SAFETY_SCENE.StreamChunk;
    if (!(await this.review(text, scene))) return false;

    if (thinking) {
      this.approvedThinking += text;
      this.thinkingText = '';
      this.releaseWindow(this.thinkingWindow);
    } else {
      this.approvedContent += text;
      this.contentText = '';
      this.releaseWindow(this.contentWindow);
    }
    await this.flushReady();
    return true;
  }

  private releaseWindow(window: PendingEvent[]): void {
    // Windows hold references to pendingQueue entries; update flags without changing queue order.
    for (const pending of window) pending.releasable = true;
    window.length = 0;
  }

  private async flushReady(): Promise<void> {
    if (this.blocked || this.networkStopped) return;
    // Release only the consecutive ready prefix at the queue head: the core ordering constraint.
    // Example: if text#1 awaits review and finish#2 is ready, finish#2 must still wait.
    const batch: IRuntimeEvent[] = [];
    while (this.pendingQueue[0]?.releasable) {
      const next = this.pendingQueue.shift();
      if (next) batch.push(next.event);
    }
    if (batch.length > 0) await this.inner.appendEvents(batch);
  }

  private async reviewFinalWindow(
    completeText: string | undefined,
    windowText: string,
    scene: SafetyScene,
  ): Promise<boolean> {
    // Prefer agent-core's complete text for review; if final omits it, fall back to the current accumulated window.
    const text = completeText && completeText.length > 0 ? completeText : windowText;
    if (!text) return true;
    return this.review(text, scene);
  }
}
