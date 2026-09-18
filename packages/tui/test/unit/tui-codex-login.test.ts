import { afterEach, describe, expect, it, vi } from "vitest";
import type { McodeCodexOAuthStatus } from "../../src/provider/contract.js";
import { TuiCodexLogin } from "../../src/tui/features/auth/codex-login.js";
import { stripAnsi, visibleWidth } from "../../src/tui/rendering/text.js";

const disconnected: McodeCodexOAuthStatus = {
  state: "disconnected",
  providerId: "openai-codex",
};
const device: McodeCodexOAuthStatus = {
  state: "pending",
  providerId: "openai-codex",
  method: "device_code",
  loginId: "attempt-1",
  deviceCode: {
    verificationUri: "https://auth.openai.com/codex/device",
    userCode: "ABCD-EFGH",
    expiresAt: Date.now() + 900_000,
  },
};

function harness(initial = disconnected) {
  const application = {
    getCodexOAuthStatus: vi.fn(
      async (): Promise<McodeCodexOAuthStatus> => initial,
    ),
    connectCodexOAuth: vi.fn(
      async (): Promise<McodeCodexOAuthStatus> => device,
    ),
    cancelCodexOAuthLogin: vi.fn(
      async (): Promise<McodeCodexOAuthStatus> => disconnected,
    ),
  };
  const openExternalTarget = vi.fn(async () => undefined);
  const onConnected = vi.fn();
  const onClose = vi.fn();
  const panel = new TuiCodexLogin({
    application,
    openExternalTarget,
    onConnected,
    onClose,
    requestRender: vi.fn(),
  });
  return {
    panel,
    application,
    openExternalTarget,
    onConnected,
    onClose,
    text: () => stripAnsi(panel.render(90).join("\n")),
  };
}

afterEach(() => vi.useRealTimers());

describe("Codex sign-in panel", () => {
  it("defaults to browser login and displays its URL when browser launch fails", async () => {
    const h = harness();
    h.application.connectCodexOAuth.mockResolvedValue({
      ...device,
      method: "browser",
      deviceCode: undefined,
      authUrl: "https://auth.openai.com/oauth/authorize?state=test",
    });
    h.openExternalTarget.mockRejectedValue(new Error("No browser"));
    await h.panel.resume();
    h.panel.handleInput("\r");
    await vi.waitFor(() =>
      expect(h.text()).toContain("Open the link above manually"),
    );
    expect(h.application.connectCodexOAuth).toHaveBeenCalledWith({
      method: "browser",
    });
    expect(h.text()).toContain(
      "https://auth.openai.com/oauth/authorize?state=test",
    );
    h.panel.dispose();
  });

  it("selects device code, displays the code and polls until connected even without a browser", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.openExternalTarget.mockRejectedValue(new Error("xdg-open unavailable"));
    await h.panel.resume();
    h.panel.handleInput("\u001b[B");
    h.panel.handleInput("\r");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.application.connectCodexOAuth).toHaveBeenCalledWith({
      method: "device_code",
    });
    expect(h.text()).toContain("ABCD-EFGH");
    expect(h.text()).toContain("https://auth.openai.com/codex/device");
    expect(h.text()).toContain("Waiting for authorization");
    h.application.getCodexOAuthStatus.mockResolvedValue({
      ...disconnected,
      state: "connected",
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.onConnected).toHaveBeenCalledOnce();
    h.panel.dispose();
  });

  it("resumes a pending device login without generating a second code", async () => {
    const h = harness(device);
    await h.panel.resume();
    expect(h.application.connectCodexOAuth).not.toHaveBeenCalled();
    expect(h.text()).toContain("ABCD-EFGH");
    h.panel.handleInput("\u001b");
    await vi.waitFor(() => expect(h.onClose).toHaveBeenCalledOnce());
    expect(h.application.cancelCodexOAuthLogin).toHaveBeenCalledWith(
      "attempt-1",
    );
    h.panel.dispose();
  });

  it("cancels an authorization that arrives after the user closes the starting panel", async () => {
    const h = harness();
    let release!: (status: McodeCodexOAuthStatus) => void;
    h.application.connectCodexOAuth.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await h.panel.resume();
    h.panel.handleInput("\u001b[B");
    h.panel.handleInput("\r");
    h.panel.handleInput("\u001b");
    h.panel.dispose();
    release(device);
    await vi.waitFor(() =>
      expect(h.application.cancelCodexOAuthLogin).toHaveBeenCalledWith(
        "attempt-1",
      ),
    );
    expect(h.openExternalTarget).not.toHaveBeenCalled();
  });

  it("shows expiry and retries the selected method, and stops polling after disposal", async () => {
    vi.useFakeTimers();
    const h = harness(device);
    await h.panel.resume();
    h.application.getCodexOAuthStatus.mockResolvedValue({
      ...disconnected,
      state: "failed",
      error: "Device code expired. Start login again.",
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.text()).toContain("Device code expired");
    h.panel.handleInput("\r");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.application.connectCodexOAuth).toHaveBeenCalledWith({
      method: "device_code",
    });
    h.panel.dispose();
    const calls = h.application.getCodexOAuthStatus.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.application.getCodexOAuthStatus).toHaveBeenCalledTimes(calls);
  });

  it("keeps the user code and cancel action visible in a narrow terminal", async () => {
    const h = harness(device);
    await h.panel.resume();
    const rows = h.panel.renderViewport(40, 12);
    const text = stripAnsi(rows.join("\n"));
    expect(text).toContain("ABCD-EFGH");
    expect(text).toContain("Esc cancel");
    expect(rows.every((row) => visibleWidth(row) <= 40)).toBe(true);
    expect(rows.length).toBeLessThanOrEqual(12);
    h.panel.dispose();
  });
});
