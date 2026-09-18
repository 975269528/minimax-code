import { beforeEach, describe, expect, it, vi } from "vitest";
import { streamOpenAICompletions } from "../src/providers/openai-completions.ts";
import { streamOpenAIResponses } from "../src/providers/openai-responses.ts";
import type { Context, Model } from "../src/types.ts";

const mockState = vi.hoisted(() => ({
	clientOptions: [] as unknown[],
	requestOptions: [] as unknown[],
	terminalError: undefined as unknown,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		constructor(options: unknown) {
			mockState.clientOptions.push(options);
		}

		chat = {
			completions: {
				create: (_params: unknown, options: unknown) => {
					mockState.requestOptions.push(options);
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield {
								id: "chatcmpl-test",
								choices: [{ index: 0, delta: { content: "ok" } }],
							};
							yield {
								id: "chatcmpl-test",
								choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
							};
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{
							data: typeof stream;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => {
						if (mockState.terminalError !== undefined) throw mockState.terminalError;
						return {
							data: stream,
							response: { status: 200, headers: new Headers() },
						};
					};
					return promise;
				},
			},
		};

		responses = {
			create: (_params: unknown, options: unknown) => {
				mockState.requestOptions.push(options);
				const stream = {
					async *[Symbol.asyncIterator]() {
						yield {
							type: "response.completed",
							response: {
								id: "resp-test",
								status: "completed",
								usage: {
									input_tokens: 1,
									output_tokens: 1,
									total_tokens: 2,
									input_tokens_details: { cached_tokens: 0 },
								},
							},
						};
					},
				};
				return {
					withResponse: async () => {
						if (mockState.terminalError !== undefined) throw mockState.terminalError;
						return {
							data: stream,
							response: { status: 200, headers: new Headers() },
						};
					},
				};
			},
		};
	}
	return { default: FakeOpenAI };
});

const model: Model<"openai-completions"> = {
	id: "test-model",
	name: "Test Model",
	api: "openai-completions",
	provider: "opencode-go",
	baseUrl: "https://opencode.ai/zen/go/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

const responsesModel: Model<"openai-responses"> = {
	id: "test-responses-model",
	name: "Test Responses Model",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

const context: Context = {
	systemPrompt: "",
	messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 }],
	tools: [],
};

async function consume(options?: {
	maxRetries?: number;
	fetch?: typeof globalThis.fetch;
	onProviderError?: (error: unknown, model: Model) => void;
	onProviderStreamEvent?: (event: unknown, model: Model) => void;
}) {
	const stream = streamOpenAICompletions(model, context, { apiKey: "test", ...options });
	for await (const _event of stream) {
		void _event;
	}
	return stream.result();
}

async function consumeResponses(options?: {
	fetch?: typeof globalThis.fetch;
	onProviderStreamEvent?: (event: unknown, model: Model) => void;
}) {
	const stream = streamOpenAIResponses(responsesModel, context, { apiKey: "test", ...options });
	for await (const _event of stream) {
		void _event;
	}
	return stream.result();
}

describe("openai-completions provider retries", () => {
	beforeEach(() => {
		mockState.clientOptions = [];
		mockState.requestOptions = [];
		mockState.terminalError = undefined;
	});

	it("disables SDK retries by default", async () => {
		await consume();
		expect(mockState.requestOptions).toEqual([expect.objectContaining({ maxRetries: 0 })]);
	});

	it("honors explicit provider retry settings", async () => {
		await consume({ maxRetries: 2 });
		expect(mockState.requestOptions).toEqual([expect.objectContaining({ maxRetries: 2 })]);
	});

	it("passes custom fetch to the OpenAI completions SDK client", async () => {
		const fetchImpl = (async () => new Response()) as typeof globalThis.fetch;
		await consume({ fetch: fetchImpl });
		expect(mockState.clientOptions[0]).toEqual(expect.objectContaining({ fetch: fetchImpl }));
	});

	it("passes custom fetch to the OpenAI responses SDK client", async () => {
		const fetchImpl = (async () => new Response()) as typeof globalThis.fetch;
		await consumeResponses({ fetch: fetchImpl });
		expect(mockState.clientOptions[0]).toEqual(expect.objectContaining({ fetch: fetchImpl }));
	});

	it("delivers parsed Chat Completions chunks to the provider observer", async () => {
		const observed: unknown[] = [];

		await consume({ onProviderStreamEvent: (event) => observed.push(event) });

		expect(observed).toEqual([
			{
				id: "chatcmpl-test",
				choices: [{ index: 0, delta: { content: "ok" } }],
			},
			{
				id: "chatcmpl-test",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			},
		]);
	});

	it("delivers parsed Responses events through the shared processor observer", async () => {
		const observed: unknown[] = [];

		await consumeResponses({ onProviderStreamEvent: (event) => observed.push(event) });

		expect(observed).toEqual([
			{
				type: "response.completed",
				response: {
					id: "resp-test",
					status: "completed",
					usage: {
						input_tokens: 1,
						output_tokens: 1,
						total_tokens: 2,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			},
		]);
	});

	it("把 provider 捕获到的原始异常交给宿主回调", async () => {
		const cause = Object.assign(new Error("getaddrinfo ENOTFOUND missing.example.com"), {
			code: "ENOTFOUND",
			hostname: "missing.example.com",
		});
		const original = new Error("Connection error.", { cause });
		const onProviderError = vi.fn();
		mockState.terminalError = original;

		const result = await consume({ onProviderError });

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Connection error.");
		expect(onProviderError).toHaveBeenCalledOnce();
		expect(onProviderError).toHaveBeenCalledWith(original, model);
	});

	it("宿主错误回调抛错时仍保留原 provider 失败", async () => {
		const original = new Error("provider failed");
		mockState.terminalError = original;

		const result = await consume({
			onProviderError: () => {
				throw new Error("observer failed");
			},
		});

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("provider failed");
	});
});
