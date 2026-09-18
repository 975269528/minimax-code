import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.ts";
import { streamSimple } from "../src/stream.ts";
import type { Context, Model, SimpleStreamOptions } from "../src/types.ts";

interface AnthropicThinkingPayload {
	model?: string;
	thinking?: { type: string; budget_tokens?: number; display?: string };
	output_config?: { effort?: string };
}

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
		this.name = "PayloadCaptured";
	}
}

function makeContext(): Context {
	return {
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	};
}

function makeCustomModel(compat?: Model<"anthropic-messages">["compat"]): Model<"anthropic-messages"> {
	return {
		// Id intentionally does not match any built-in adaptive substring. This
		// mirrors corporate proxy schemes such as `anthropic--claude-opus-latest`.
		id: "vendor--claude-opus-latest",
		name: "Vendor Proxy Opus Latest",
		api: "anthropic-messages",
		provider: "vendor-proxy",
		baseUrl: "http://127.0.0.1:9",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
		compat,
	};
}

async function capturePayload(
	model: Model<"anthropic-messages">,
	options?: SimpleStreamOptions,
): Promise<AnthropicThinkingPayload> {
	let capturedPayload: AnthropicThinkingPayload | undefined;

	const payloadCaptureModel: Model<"anthropic-messages"> = {
		...model,
		baseUrl: "http://127.0.0.1:9",
	};

	const s = streamSimple(payloadCaptureModel, makeContext(), {
		...options,
		apiKey: "fake-key",
		onPayload: (payload) => {
			capturedPayload = payload as AnthropicThinkingPayload;
			throw new PayloadCaptured();
		},
	});

	await s.result();

	if (!capturedPayload) {
		throw new Error("Expected payload to be captured before request failure");
	}

	return capturedPayload;
}

describe("Anthropic forceAdaptiveThinking compat override", () => {
	it("sends legacy thinking payload for custom model ids by default", async () => {
		const payload = await capturePayload(makeCustomModel(), { reasoning: "medium" });

		expect(payload.thinking?.type).toBe("enabled");
		expect(payload.output_config).toBeUndefined();
	});

	it("sends adaptive thinking payload when compat.forceAdaptiveThinking is true", async () => {
		const payload = await capturePayload(makeCustomModel({ forceAdaptiveThinking: true }), { reasoning: "medium" });

		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.output_config).toEqual({ effort: "medium" });
	});

	it.each([
		"claude-opus-5[1m]",
		"claude-sonnet-5",
		"claude-fable-5",
		"claude-mythos-5",
		"claude-mythos-preview",
	])("omits thinking while preserving effort for default-thinking model %s", async (modelId) => {
		const model = {
			...makeCustomModel(),
			id: modelId,
		};
		const payload = await capturePayload(model, { reasoning: "medium" });

		expect(payload.model).toBe(model.id);
		expect(payload).not.toHaveProperty("thinking");
		expect(payload.output_config).toEqual({ effort: "medium" });
	});

	it("does not treat an arbitrary bracket suffix as a default-thinking model", async () => {
		const model = { ...makeCustomModel(), id: "claude-opus-5[foo]" };
		const payload = await capturePayload(model, { reasoning: "medium" });

		expect(payload.thinking?.type).toBe("enabled");
		expect(payload.output_config).toBeUndefined();
	});

	it("keeps an explicit disabled thinking parameter for models that allow it", async () => {
		const model = { ...makeCustomModel(), id: "claude-opus-5" };
		const payload = await capturePayload(model);

		expect(payload.thinking).toEqual({ type: "disabled" });
		expect(payload.output_config).toBeUndefined();
	});

	it("omits thinking with native xhigh effort for Claude Fable 5", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-fable-5"), { reasoning: "xhigh" });

		expect(payload).not.toHaveProperty("thinking");
		expect(payload.output_config).toEqual({ effort: "xhigh" });
	});

	it("allows built-in adaptive models to opt out with compat.forceAdaptiveThinking false", async () => {
		const model: Model<"anthropic-messages"> = {
			...getModel("anthropic", "claude-opus-4-8"),
			compat: { forceAdaptiveThinking: false },
		};
		const payload = await capturePayload(model, { reasoning: "medium" });

		expect(payload.thinking?.type).toBe("enabled");
		expect(payload.output_config).toBeUndefined();
	});

	it("preserves thinking.type=disabled when reasoning is off regardless of override", async () => {
		const payload = await capturePayload(makeCustomModel({ forceAdaptiveThinking: true }));

		expect(payload.thinking).toEqual({ type: "disabled" });
		expect(payload.output_config).toBeUndefined();
	});
});
