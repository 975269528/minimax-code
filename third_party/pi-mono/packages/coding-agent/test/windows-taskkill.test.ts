import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const childProcessMocks = vi.hoisted(() => ({
	spawn: vi.fn(),
	spawnSync: vi.fn(),
}));

vi.mock("child_process", () => ({
	spawn: childProcessMocks.spawn,
	spawnSync: childProcessMocks.spawnSync,
}));

import {
	resolveWindowsTaskkillPath,
	spawnWindowsTaskkill,
	terminateProcessTreeGracefully,
} from "../src/utils/shell.ts";

function createFakeChild(): { child: ChildProcess; unref: ReturnType<typeof vi.fn> } {
	const child = new EventEmitter() as ChildProcess;
	const unref = vi.fn();
	child.unref = unref;
	return { child, unref };
}

describe("Windows taskkill process-tree termination", () => {
	beforeEach(() => {
		childProcessMocks.spawn.mockReset();
		vi.spyOn(process, "kill").mockReturnValue(true);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("resolves taskkill.exe from SystemRoot without depending on PATH", () => {
		expect(resolveWindowsTaskkillPath({ SystemRoot: "D:\\Windows", PATH: "C:\\tools" })).toBe(
			"D:\\Windows\\System32\\taskkill.exe",
		);
		expect(resolveWindowsTaskkillPath({ SYSTEMROOT: "E:\\WinNT" })).toBe("E:\\WinNT\\System32\\taskkill.exe");
	});

	it("falls back to taskkill.exe when Windows root variables are unavailable", () => {
		expect(resolveWindowsTaskkillPath({ PATH: "C:\\tools" })).toBe("taskkill.exe");
	});

	it("uses the absolute executable and protects the graceful error event", () => {
		const { child, unref } = createFakeChild();
		childProcessMocks.spawn.mockReturnValue(child);

		spawnWindowsTaskkill(4321, false, { SystemRoot: "C:\\Windows" });

		expect(childProcessMocks.spawn).toHaveBeenCalledWith(
			"C:\\Windows\\System32\\taskkill.exe",
			["/T", "/PID", "4321"],
			{
				stdio: "ignore",
				detached: true,
				windowsHide: true,
			},
		);
		expect(unref).toHaveBeenCalledOnce();
		expect(() => child.emit("error", Object.assign(new Error("spawn failed"), { code: "ENOENT" }))).not.toThrow();
		expect(process.kill).toHaveBeenCalledWith(4321, "SIGKILL");
	});

	it("protects the forced taskkill path and falls back when spawn throws synchronously", () => {
		childProcessMocks.spawn.mockImplementation(() => {
			throw Object.assign(new Error("spawn failed"), { code: "ENOENT" });
		});

		expect(() => spawnWindowsTaskkill(9876, true, { windir: "C:\\Windows" })).not.toThrow();
		expect(childProcessMocks.spawn).toHaveBeenCalledWith(
			"C:\\Windows\\System32\\taskkill.exe",
			["/F", "/T", "/PID", "9876"],
			{
				stdio: "ignore",
				detached: true,
				windowsHide: true,
			},
		);
		expect(process.kill).toHaveBeenCalledWith(9876, "SIGKILL");
	});

	it("does not rethrow when taskkill and the root-process fallback both fail", () => {
		const { child } = createFakeChild();
		childProcessMocks.spawn.mockReturnValue(child);
		vi.mocked(process.kill).mockImplementation(() => {
			throw Object.assign(new Error("kill failed"), { code: "ESRCH" });
		});

		spawnWindowsTaskkill(2468, true, {});

		expect(() => child.emit("error", Object.assign(new Error("spawn failed"), { code: "ENOENT" }))).not.toThrow();
		expect(process.kill).toHaveBeenCalledWith(2468, "SIGKILL");
	});

	it("keeps the forced /F /T escalation observable until its grace timer fires", async () => {
		vi.useFakeTimers();
		vi.spyOn(process, "platform", "get").mockReturnValue("win32");
		childProcessMocks.spawn.mockImplementation(() => createFakeChild().child);

		const termination = terminateProcessTreeGracefully(1357, 3000);
		let settled = false;
		void termination.settled.then(() => {
			settled = true;
		});
		expect(childProcessMocks.spawn.mock.calls[0]?.[1]).toEqual(["/T", "/PID", "1357"]);
		expect(settled).toBe(false);

		await vi.advanceTimersByTimeAsync(3000);
		expect(childProcessMocks.spawn.mock.calls[1]?.[1]).toEqual(["/F", "/T", "/PID", "1357"]);
		await termination.settled;
		expect(settled).toBe(true);
	});
});
