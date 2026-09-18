import { describe, expect, it, vi } from "vitest";

import { streamOpenAICompletions } from "../src/providers/openai-completions.ts";
import type { Context, Model } from "../src/types.ts";
import { observeProviderEvents, withProviderEventObserver } from "../src/utils/provider-error.ts";

const model: Model<"openai-completions"> = {
	id: "custom-model",
	name: "Custom Model",
	api: "openai-completions",
	provider: "custom_provider:internal-platform",
	baseUrl: "https://missing.example.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: 0 }],
};

describe("provider 原始错误回调", () => {
	it("保留 OpenAI SDK 连接异常及底层 DNS cause", async () => {
		const dnsError = Object.assign(new Error("getaddrinfo ENOTFOUND missing.example.com"), {
			code: "ENOTFOUND",
			errno: -3008,
			syscall: "getaddrinfo",
			hostname: "missing.example.com",
		});
		const fetchError = new TypeError("fetch failed", { cause: dnsError });
		const fetchImpl = vi.fn(async () => {
			throw fetchError;
		}) as unknown as typeof fetch;
		const onProviderError = vi.fn();

		const stream = streamOpenAICompletions(model, context, {
			apiKey: "test-key",
			fetch: fetchImpl,
			maxRetries: 0,
			onProviderError,
		});
		for await (const event of stream) void event;
		const result = await stream.result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Connection error.");
		expect(onProviderError).toHaveBeenCalledOnce();
		const raw = onProviderError.mock.calls[0][0] as Error & { cause?: unknown };
		expect(raw.name).toBe("Error");
		expect(raw.message).toBe("Connection error.");
		expect(raw.cause).toBe(fetchError);
		expect((raw.cause as Error & { cause?: unknown }).cause).toBe(dnsError);
	});
});

describe("provider stream event observer", () => {
	it("returns the exact provider iterable when no observer is configured", () => {
		const source = {
			async *[Symbol.asyncIterator]() {
				yield { type: "one" };
			},
		};

		expect(withProviderEventObserver(source, undefined, model)).toBe(source);
	});

	it("observes every parsed event without changing the iterable when the observer throws", async () => {
		const events = [{ type: "one" }, { type: "two" }];
		const observed: unknown[] = [];
		const source = async function* () {
			for (const event of events) yield event;
		};

		const yielded: unknown[] = [];
		for await (const event of observeProviderEvents(
			source(),
			(event) => {
				observed.push(event);
				throw new Error("observer failure");
			},
			model,
		)) {
			yielded.push(event);
		}

		expect(observed).toEqual(events);
		expect(yielded).toEqual(events);
		expect(yielded[0]).toBe(events[0]);
		expect(yielded[1]).toBe(events[1]);
	});
});
