import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { createLocalBashOperations } from "../src/core/tools/bash.js";

describe("local Bash process observations", () => {
  it("observes a real shell spawn without changing a nonzero exit", async () => {
    const onProcessEvent = vi.fn();
    const result = await createLocalBashOperations().exec("exit 7", tmpdir(), { onData: () => {}, onProcessEvent });
    expect(result.exitCode).toBe(7);
    expect(onProcessEvent).toHaveBeenCalledWith({ type: "spawned", processRole: "shell" });
  });
  it("does not fabricate a spawn before cancellation or cwd validation", async () => {
    const onProcessEvent = vi.fn();
    await expect(createLocalBashOperations().exec("exit 0", tmpdir(), {
      onData: () => {}, signal: AbortSignal.abort(), onProcessEvent,
    })).rejects.toThrow("aborted");
    expect(onProcessEvent).not.toHaveBeenCalled();
  });
  it("reports timeout from the timer and ignores throwing observers", async () => {
    const onProcessEvent = vi.fn(() => { throw new Error("observer failed"); });
    const command = process.platform === "win32" ? "Start-Sleep -Seconds 3" : "sleep 3";
    await expect(createLocalBashOperations().exec(command, tmpdir(), {
      onData: () => {}, timeout: 0.05, onProcessEvent,
    })).rejects.toThrow("timeout:");
    expect(onProcessEvent).toHaveBeenCalledWith({ type: "timeout", processRole: "shell" });
  });
});
