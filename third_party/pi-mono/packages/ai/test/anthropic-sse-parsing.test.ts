import type Anthropic from "@anthropic-ai/sdk";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.ts";
import { streamAnthropic } from "../src/providers/anthropic.ts";
import type { Context, ToolCall } from "../src/types.ts";

function createSseResponse(events: Array<{ event: string; data: string }>): Response {
	const body = events.map(({ event, data }) => `event: ${event}\ndata: ${data}\n`).join("\n");
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

const minimalAnthropicEvents = [
	{
		event: "message_start",
		data: JSON.stringify({
			type: "message_start",
			message: {
				id: "msg_test",
				usage: {
					input_tokens: 12,
					output_tokens: 0,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				},
			},
		}),
	},
	{
		event: "content_block_start",
		data: JSON.stringify({
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		}),
	},
	{
		event: "content_block_delta",
		data: JSON.stringify({
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: "Hello" },
		}),
	},
	{
		event: "content_block_stop",
		data: JSON.stringify({ type: "content_block_stop", index: 0 }),
	},
	{
		event: "message_delta",
		data: JSON.stringify({
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: {
				input_tokens: 12,
				output_tokens: 5,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
		}),
	},
	{
		event: "message_stop",
		data: JSON.stringify({ type: "message_stop" }),
	},
];

function createFakeAnthropicClient(response: Response): Anthropic {
	return {
		messages: {
			create: () => ({
				asResponse: async () => response,
			}),
		},
	} as unknown as Anthropic;
}

describe("Anthropic raw SSE parsing", () => {
	it.each(["pending", "rejecting"] as const)(
		"settles an aborted pending body read when transport cancellation is %s",
		async (cancellation) => {
			const abort = new AbortController();
			let notifyPendingRead!: () => void;
			const pendingRead = new Promise<void>((resolve) => {
				notifyPendingRead = resolve;
			});
			const cancel = vi.fn(() =>
				cancellation === "pending"
					? new Promise<void>(() => {})
					: Promise.reject(new Error("Transport cancellation failed")),
			);
			const initialEvents = [
				minimalAnthropicEvents[0],
				{
					event: "content_block_start",
					data: JSON.stringify({
						type: "content_block_start",
						index: 0,
						content_block: { type: "thinking", thinking: "" },
					}),
				},
				{
					event: "content_block_delta",
					data: JSON.stringify({
						type: "content_block_delta",
						index: 0,
						delta: { type: "thinking_delta", thinking: "Partial reasoning" },
					}),
				},
			];
			const body = new ReadableStream<Uint8Array>(
				{
					start(controller) {
						const text = initialEvents.map(({ event, data }) => `event: ${event}\ndata: ${data}\n\n`).join("");
						controller.enqueue(new TextEncoder().encode(text));
					},
					pull() {
						notifyPendingRead();
						return new Promise<void>(() => {});
					},
					cancel,
				},
				{ highWaterMark: 0 },
			);
			const stream = streamAnthropic(
				getModel("anthropic", "claude-haiku-4-5"),
				{ messages: [{ role: "user", content: "Say hello.", timestamp: Date.now() }] },
				{ client: createFakeAnthropicClient(new Response(body)), signal: abort.signal },
			);

			await pendingRead;
			abort.abort("output_safety");
			const result = await stream.result();
			const eventTypes: string[] = [];
			for await (const event of stream) eventTypes.push(event.type);

			expect(result.stopReason).toBe("aborted");
			expect(result.content).toMatchObject([{ type: "thinking", thinking: "Partial reasoning" }]);
			expect(eventTypes.filter((type) => type === "error" || type === "done")).toEqual(["error"]);
			expect(cancel).toHaveBeenCalledOnce();
			expect(body.locked).toBe(false);
		},
		1_000,
	);

	it("cancels the response body when the signal is already aborted", async () => {
		const abort = new AbortController();
		abort.abort("output_safety");
		const cancel = vi.fn();
		const body = new ReadableStream<Uint8Array>({ cancel });
		const stream = streamAnthropic(
			getModel("anthropic", "claude-haiku-4-5"),
			{ messages: [{ role: "user", content: "Say hello.", timestamp: Date.now() }] },
			{ client: createFakeAnthropicClient(new Response(body)), signal: abort.signal },
		);

		expect((await stream.result()).stopReason).toBe("aborted");
		expect(cancel).toHaveBeenCalledOnce();
		expect(body.locked).toBe(false);
	});

	it("delivers parsed provider events to the synchronous observer", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5");
		const context: Context = {
			messages: [{ role: "user", content: "Say hello.", timestamp: Date.now() }],
		};
		const observed: unknown[] = [];
		const stream = streamAnthropic(model, context, {
			client: createFakeAnthropicClient(createSseResponse(minimalAnthropicEvents)),
			onProviderStreamEvent: (event) => observed.push(event),
		});

		await stream.result();

		expect(observed.map((event) => (event as { type: string }).type)).toEqual([
			"message_start",
			"content_block_start",
			"content_block_delta",
			"content_block_stop",
			"message_delta",
			"message_stop",
		]);
		expect(observed[2]).toMatchObject({
			type: "content_block_delta",
			delta: { type: "text_delta", text: "Hello" },
		});
	});

	it("repairs malformed SSE JSON and malformed streamed tool JSON", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5");
		const context: Context = {
			messages: [{ role: "user", content: "Use the edit tool.", timestamp: Date.now() }],
			tools: [
				{
					name: "edit",
					description: "Edit a file.",
					parameters: Type.Object({
						path: Type.String(),
						text: Type.String(),
					}),
				},
			],
		};

		const malformedToolJsonDelta = String.raw`{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"path\":\"A\H\",\"text\":\"col1	col2\"}"}}`;

		const response = createSseResponse([
			{
				event: "message_start",
				data: JSON.stringify({
					type: "message_start",
					message: {
						id: "msg_test",
						usage: {
							input_tokens: 12,
							output_tokens: 0,
							cache_read_input_tokens: 0,
							cache_creation_input_tokens: 0,
						},
					},
				}),
			},
			{
				event: "content_block_start",
				data: JSON.stringify({
					type: "content_block_start",
					index: 0,
					content_block: {
						type: "tool_use",
						id: "toolu_test",
						name: "edit",
						input: {},
					},
				}),
			},
			{ event: "content_block_delta", data: malformedToolJsonDelta },
			{
				event: "content_block_stop",
				data: JSON.stringify({ type: "content_block_stop", index: 0 }),
			},
			{
				event: "message_delta",
				data: JSON.stringify({
					type: "message_delta",
					delta: { stop_reason: "tool_use" },
					usage: {
						input_tokens: 12,
						output_tokens: 5,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				}),
			},
			{
				event: "message_stop",
				data: JSON.stringify({ type: "message_stop" }),
			},
		]);

		const stream = streamAnthropic(model, context, {
			client: createFakeAnthropicClient(response),
		});
		const result = await stream.result();

		expect(result.stopReason).toBe("toolUse");
		expect(result.errorMessage).toBeUndefined();

		const toolCall = result.content.find((block): block is ToolCall => block.type === "toolCall");
		expect(toolCall).toBeDefined();
		expect(toolCall?.arguments).toEqual({
			path: "A\\H",
			text: "col1\tcol2",
		});
	});

	it("ignores unknown SSE events after message_stop", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5");
		const context: Context = {
			messages: [{ role: "user", content: "Say hello.", timestamp: Date.now() }],
		};
		const response = createSseResponse([
			...minimalAnthropicEvents,
			{ event: "done", data: "[DONE]" },
			{ event: "proxy.stats", data: "not json" },
		]);

		const stream = streamAnthropic(model, context, {
			client: createFakeAnthropicClient(response),
		});
		const result = await stream.result();

		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toEqual([{ type: "text", text: "Hello" }]);
	});
});
