/**
 * `AgentEvent` — the in-process event stream emitted by an agent runtime
 * (e.g. `pi-agent-core`'s `Agent`) as it advances through an LLM turn.
 *
 * **Pure types only** — no implementations. This file exists so daemon and
 * cloud-runtime can share a single event vocabulary without depending on
 * `@earendil-works/pi-agent-core` directly. The shape mirrors pi-agent-core's
 * `AgentEvent` so structural compatibility holds: an `EventBridge` wired to
 * pi-agent-core can up-cast its events into this type without remapping.
 *
 * Lifecycle of a turn:
 * ```
 * agent_start
 *   ↓
 *   turn_start
 *     ↓
 *     message_start (assistant message handle opened)
 *     message_update (delta — text/thinking/tool_call additions)
 *     message_end (message body finalised)
 *     ↓
 *     tool_execution_start (tool dispatched)
 *     tool_execution_update (partial result / progress)
 *     tool_execution_end (tool resolved)
 *   ↓
 *   turn_end (this LLM turn concluded; another turn may follow)
 *   ↓
 * agent_end (the entire run is finished — emits the final message log)
 * ```
 *
 * Daemon usage hint
 * -----------------
 * Daemon's bridge converts `AgentEvent` into `AgentMessageChunk` /
 * `AgentMessage` for SSE delivery to local UI clients. `tool_execution_*`
 * events become `AgentMessageChunk.tool_calls[].tool_call_status` updates.
 *
 * Cloud impl hint
 * ---------------
 * Cloud-runtime's `EventBridge` converts `AgentEvent` into the canonical
 * `RuntimeEvent` (`stream.resp` / `session.status`), then `ExchangeSink`
 * adapts to `AgentMessageChunk` for Phase 1 and pushes `RuntimeEvent`
 * directly in Phase 2.
 */

import type { AgentMessage } from './agent-message.js';

/**
 * A "turn-result" tool-result frame attached to a `turn_end` event. Mirrors
 * pi-agent-core's `ToolResultMessage` minimally — agent-core does not enforce
 * a specific tool calling convention.
 */
export interface ToolResultMessage {
  /** ID of the tool call that this result resolves. */
  toolCallId: string;
  /** Tool name (echoed for logging / routing convenience). */
  toolName: string;
  /** Free-form result payload — typically JSON-serialisable. */
  result: unknown;
  /** True when the tool reported a failure. */
  isError: boolean;
}

/**
 * Lower-level message-update payload carried inside `message_update`. The
 * generic `unknown` is intentional — agent-core does not constrain the
 * internal LLM-runtime delta shape, but downstream bridges may narrow.
 */
export type AssistantMessageEvent = unknown;

/** Run started — fires once per `agent.run()`. */
export interface AgentStartEvent {
  type: 'agent_start';
}

/** Run ended — fires once per `agent.run()` after settlement. */
export interface AgentEndEvent {
  type: 'agent_end';
  /** Snapshot of the message log at run end. */
  messages: AgentMessage[];
}

/** A single LLM turn opened. Multiple turns may run within one agent run. */
export interface TurnStartEvent {
  type: 'turn_start';
}

/**
 * A single LLM turn closed. Carries the assistant message that completed
 * during this turn plus all tool results executed by the runtime.
 */
export interface TurnEndEvent {
  type: 'turn_end';
  message: AgentMessage;
  toolResults: ToolResultMessage[];
}

/** Assistant message handle opened — first delta arrives next. */
export interface MessageStartEvent {
  type: 'message_start';
  message: AgentMessage;
}

/** Streaming delta for the in-flight assistant message. */
export interface MessageUpdateEvent {
  type: 'message_update';
  message: AgentMessage;
  assistantMessageEvent: AssistantMessageEvent;
}

/** Assistant message body finalised — no further deltas for this msg. */
export interface MessageEndEvent {
  type: 'message_end';
  message: AgentMessage;
}

/** A tool dispatch began. */
export interface ToolExecutionStartEvent {
  type: 'tool_execution_start';
  toolCallId: string;
  toolName: string;
  args: unknown;
}

/**
 * Tool reported progress — partial result before the call resolves.
 * Optional and may not be emitted by every tool.
 */
export interface ToolExecutionUpdateEvent {
  type: 'tool_execution_update';
  toolCallId: string;
  toolName: string;
  args: unknown;
  partialResult: unknown;
}

/** Tool dispatch resolved — `result` carries the final value. */
export interface ToolExecutionEndEvent {
  type: 'tool_execution_end';
  toolCallId: string;
  toolName: string;
  result: unknown;
  isError: boolean;
}

/**
 * Discriminated union of all events an `Agent` runtime emits during a run.
 *
 * Consumers are expected to switch on `event.type`. New event variants may
 * be added in non-breaking minor releases — handle the default case
 * defensively.
 */
export type AgentEvent =
  | AgentStartEvent
  | AgentEndEvent
  | TurnStartEvent
  | TurnEndEvent
  | MessageStartEvent
  | MessageUpdateEvent
  | MessageEndEvent
  | ToolExecutionStartEvent
  | ToolExecutionUpdateEvent
  | ToolExecutionEndEvent;

/** Type tag literal — handy for narrowing handlers. */
export type AgentEventType = AgentEvent['type'];
