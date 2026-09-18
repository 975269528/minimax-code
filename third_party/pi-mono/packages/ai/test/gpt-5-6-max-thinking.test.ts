import { describe, expect, it } from "vitest";
import { clampThinkingLevel, getModel, getModels, getSupportedThinkingLevels } from "../src/models.ts";
import { streamSimpleOpenAICodexResponses } from "../src/providers/openai-codex-responses.ts";
import type { Context, Model } from "../src/types.ts";

const CODEX_MODELS = ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"] as const;

function mockCodexToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
	).toString("base64");
	return `header.${payload}.signature`;
}

describe("GPT-5.6 Max thinking", () => {
	it.each(CODEX_MODELS)("publishes final Codex metadata for %s", (modelId) => {
		const model = getModel("openai-codex", modelId);
		expect(model).toMatchObject({
			id: modelId,
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			contextWindow: 372000,
			maxTokens: 128000,
			thinkingLevelMap: { minimal: "low", xhigh: "xhigh", max: "max" },
		});
		expect(getSupportedThinkingLevels(model)).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
	});

	it.each(CODEX_MODELS)("publishes final direct OpenAI metadata for %s", (modelId) => {
		expect(getModel("openai", modelId)).toMatchObject({
			id: modelId,
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			contextWindow: 272000,
			maxTokens: 128000,
			thinkingLevelMap: { off: "none", xhigh: "xhigh", max: "max" },
		});
	});

	it.each(["openai", "openai-codex"] as const)("does not publish a bare gpt-5.6 alias for %s", (provider) => {
		expect(getModels(provider).some((model) => model.id === "gpt-5.6")).toBe(false);
	});

	it("keeps Max independent from xhigh when clamping", () => {
		const ordinary: Model<"openai-completions"> = {
			id: "ordinary-reasoning",
			name: "Ordinary Reasoning",
			api: "openai-completions",
			provider: "test",
			baseUrl: "https://example.com/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		};
		const maxOnly = { ...ordinary, thinkingLevelMap: { xhigh: null, max: "max" } };

		expect(getSupportedThinkingLevels(ordinary)).toEqual(["off", "minimal", "low", "medium", "high"]);
		expect(clampThinkingLevel(ordinary, "max")).toBe("high");
		expect(getSupportedThinkingLevels(maxOnly)).toEqual(["off", "minimal", "low", "medium", "high", "max"]);
		expect(clampThinkingLevel(maxOnly, "xhigh")).toBe("max");
	});

	it("sends reasoning.effort=max through the Codex adapter", async () => {
		const context: Context = {
			systemPrompt: "Be concise.",
			messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
		};
		let payload: unknown;

		await streamSimpleOpenAICodexResponses(getModel("openai-codex", "gpt-5.6-sol"), context, {
			apiKey: mockCodexToken(),
			reasoning: "max",
			onPayload: (request) => {
				payload = request;
				throw new Error("payload captured");
			},
		}).result();

		expect(payload).toMatchObject({ reasoning: { effort: "max", summary: "auto" } });
	});
});
