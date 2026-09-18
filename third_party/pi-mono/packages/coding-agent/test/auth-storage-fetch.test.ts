import { describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";

function jsonResponse(body: unknown, status: number = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function createOpenAICodexAccessToken(accountId: string): string {
	const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64");
	const payload = Buffer.from(
		JSON.stringify({
			"https://api.openai.com/auth": {
				chatgpt_account_id: accountId,
			},
		}),
	).toString("base64");
	return `${header}.${payload}.signature`;
}

describe("AuthStorage fetch injection", () => {
	it("refreshes expired OAuth credentials through the injected fetch implementation", async () => {
		const accessToken = createOpenAICodexAccessToken("account-auth-storage");
		const authStorage = AuthStorage.inMemory({
			"openai-codex": {
				type: "oauth",
				access: "expired-access-token",
				refresh: "refresh-token",
				expires: 0,
			},
		});
		const injectedFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			const params = new URLSearchParams(String(init?.body));
			expect(params.get("grant_type")).toBe("refresh_token");
			expect(params.get("refresh_token")).toBe("refresh-token");
			return jsonResponse({
				access_token: accessToken,
				refresh_token: "next-refresh-token",
				expires_in: 3600,
			});
		});
		const globalFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			throw new Error("global fetch should not be used");
		});

		await expect(
			authStorage.getApiKey("openai-codex", {
				includeFallback: false,
				fetch: injectedFetch as unknown as typeof fetch,
			}),
		).resolves.toBe(accessToken);
		expect(injectedFetch).toHaveBeenCalledTimes(1);
		expect(globalFetch).not.toHaveBeenCalled();
		globalFetch.mockRestore();
	});
});
