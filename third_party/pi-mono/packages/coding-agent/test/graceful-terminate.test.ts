import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalBashOperations } from "../src/core/tools/bash.ts";
import { terminateProcessTreeGracefully } from "../src/utils/shell.ts";

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		// An orphan killed by the guardian can remain briefly as a zombie on
		// macOS/Linux. It is already inert and must not be mistaken for a
		// still-running process tree merely because kill(pid, 0) succeeds.
		const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
			encoding: "utf8",
		}).stdout.trim();
		return state.length > 0 && !state.startsWith("Z");
	} catch {
		return false;
	}
}

// Unix-only: the SIGTERM→grace→SIGKILL escalation is signal-specific. On Windows
// the analogue is `taskkill /T` (graceful) then `taskkill /F /T` (force); that
// path has no catchable-signal semantics to assert here.
describe.skipIf(process.platform === "win32")("terminateProcessTreeGracefully (Unix signals)", () => {
	const spawned: ChildProcess[] = [];

	afterEach(() => {
		for (const child of spawned.splice(0)) {
			if (child.pid && child.exitCode === null && child.signalCode === null) {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					// Already gone.
				}
			}
		}
	});

	function spawnDetached(script: string): { child: ChildProcess; getStdout: () => string } {
		const child = spawn("/bin/bash", ["-c", script], {
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		spawned.push(child);
		let stdout = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		return { child, getStdout: () => stdout };
	}

	function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
		return new Promise((resolve) => {
			child.once("exit", (code, signal) => resolve({ code, signal }));
		});
	}

	async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			if (predicate()) return;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		throw new Error("waitFor timed out");
	}

	it("sends SIGTERM first so a TERM trap runs its cleanup before exit", async () => {
		const { child, getStdout } = spawnDetached(
			`trap 'echo TRAPPED; exit 0' TERM; echo READY; while true; do sleep 0.05; done`,
		);
		await waitFor(() => getStdout().includes("READY"));

		const cancel = terminateProcessTreeGracefully(child.pid!);
		const { code, signal } = await waitForExit(child);
		cancel();

		// The trap fired (SIGTERM was delivered, not an uncatchable SIGKILL) and
		// the script exited on its own terms.
		expect(getStdout()).toContain("TRAPPED");
		expect(signal).toBeNull();
		expect(code).toBe(0);
	});

	it("escalates to SIGKILL when the process ignores SIGTERM past the grace window", async () => {
		const { child, getStdout } = spawnDetached(`trap '' TERM; echo READY; while true; do sleep 0.05; done`);
		await waitFor(() => getStdout().includes("READY"));

		const termination = terminateProcessTreeGracefully(child.pid!, 200);
		const { signal } = await waitForExit(child);
		await termination.settled;

		expect(signal).toBe("SIGKILL");
	});

	it("returns a canceller that disarms the pending SIGKILL escalation", async () => {
		const { child, getStdout } = spawnDetached(
			`trap 'echo TRAPPED; exit 0' TERM; echo READY; while true; do sleep 0.05; done`,
		);
		await waitFor(() => getStdout().includes("READY"));

		// A long grace window; the trap exits the process well before it elapses,
		// then we cancel so no late SIGKILL is aimed at a possibly-reused PID.
		const cancel = terminateProcessTreeGracefully(child.pid!, 10_000);
		await waitForExit(child);
		expect(() => cancel()).not.toThrow();
	});
});

// P1 regression: on abort, createLocalBashOperations must NOT cancel the SIGKILL
// escalation while a SIGTERM-ignoring descendant is still alive in the group.
// waitForChildProcess resolves when the shell exits, but a background child that
// ignores SIGTERM keeps the group alive; cancelling then would leave it running.
describe.skipIf(process.platform === "win32")("createLocalBashOperations abort escalation", () => {
	async function readPgidChildPid(markerFile: string): Promise<number> {
		const start = Date.now();
		const { readFileSync, existsSync } = await import("node:fs");
		while (Date.now() - start < 3000) {
			if (existsSync(markerFile)) {
				const pid = Number.parseInt(readFileSync(markerFile, "utf-8").trim(), 10);
				if (Number.isFinite(pid) && pid > 0) return pid;
			}
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		throw new Error("descendant pid marker never appeared");
	}

	it("still SIGKILLs a SIGTERM-ignoring descendant after abort (no early cancel)", async () => {
		const { mkdtempSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = mkdtempSync(join(tmpdir(), "graceful-abort-"));
		const marker = join(dir, "descendant.pid");
		let descendantPid = 0;
		const controller = new AbortController();

		// The shell backgrounds a child that ignores SIGTERM and records its PID,
		// installs its own quick TERM trap, then waits. On abort the shell's trap
		// exits fast (shell gone) but the backgrounded child must still be killed.
		const command =
			`bash -c 'trap "" TERM; echo $$ > ${marker}; while true; do sleep 0.1; done' & ` + `trap 'exit 0' TERM; wait`;

		const ops = createLocalBashOperations();
		const exec = ops.exec(command, dir, { onData: () => {}, signal: controller.signal });

		descendantPid = await readPgidChildPid(marker);
		expect(isAlive(descendantPid)).toBe(true);

		controller.abort();
		await exec.catch(() => {});

		try {
			// Give the grace-window escalation time to fire on the process group.
			const start = Date.now();
			while (Date.now() - start < 6000 && isAlive(descendantPid)) {
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			expect(isAlive(descendantPid)).toBe(false);
		} finally {
			if (descendantPid && isAlive(descendantPid)) {
				try {
					process.kill(descendantPid, "SIGKILL");
				} catch {
					// already gone
				}
			}
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe.skipIf(process.platform === "win32")("createLocalBashOperations parent-death guard", () => {
	const waitUntil = async (predicate: () => boolean, timeoutMs: number): Promise<void> => {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (predicate()) return;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		throw new Error("waitUntil timed out");
	};

	it("stops the detached bash process group when its host is SIGKILLed", async () => {
		const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = mkdtempSync(join(tmpdir(), "bash-parent-death-"));
		const marker = join(dir, "bash.pid");
		const fixture = fileURLToPath(new URL("./fixtures/parent-death-guard-host.ts", import.meta.url));
		const tsxLoader = createRequire(import.meta.url).resolve("tsx/esm");
		const host = spawn(process.execPath, ["--import", tsxLoader, fixture, marker], {
			cwd: dir,
			stdio: "ignore",
		});
		let bashPid = 0;
		try {
			await waitUntil(() => {
				try {
					bashPid = Number.parseInt(readFileSync(marker, "utf8").trim(), 10);
					return Number.isFinite(bashPid) && bashPid > 0 && isAlive(bashPid);
				} catch {
					return false;
				}
			}, 5000);

			host.kill("SIGKILL");
			await waitUntil(() => !isAlive(bashPid), 6000);
			expect(isAlive(bashPid)).toBe(false);
		} finally {
			if (host.pid && isAlive(host.pid)) host.kill("SIGKILL");
			if (bashPid && isAlive(bashPid)) {
				try {
					process.kill(-bashPid, "SIGKILL");
				} catch {
					// Already gone.
				}
			}
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("registers every target on the shared guardian before its command is released", async () => {
		const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = mkdtempSync(join(tmpdir(), "bash-parent-death-shared-"));
		const markers = [join(dir, "first.pid"), join(dir, "second.pid")];
		const fixture = fileURLToPath(new URL("./fixtures/parent-death-guard-shared-host.ts", import.meta.url));
		const tsxLoader = createRequire(import.meta.url).resolve("tsx/esm");
		const host = spawn(process.execPath, ["--import", tsxLoader, fixture, ...markers], {
			cwd: dir,
			stdio: "ignore",
		});
		const bashPids = [0, 0];

		try {
			await waitUntil(() => {
				for (const [index, marker] of markers.entries()) {
					try {
						bashPids[index] = Number.parseInt(readFileSync(marker, "utf8").trim(), 10);
					} catch {
						return false;
					}
				}
				return bashPids.every((pid) => Number.isFinite(pid) && pid > 0 && isAlive(pid));
			}, 5000);

			host.kill("SIGKILL");
			await waitUntil(() => bashPids.every((pid) => !isAlive(pid)), 6000);
			expect(bashPids.every((pid) => !isAlive(pid))).toBe(true);
		} finally {
			if (host.pid && isAlive(host.pid)) host.kill("SIGKILL");
			for (const pid of bashPids) {
				if (!pid || !isAlive(pid)) continue;
				try {
					process.kill(-pid, "SIGKILL");
				} catch {
					// Already gone.
				}
			}
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps a second lease armed when an older lease for the same PID disarms", async () => {
		const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = mkdtempSync(join(tmpdir(), "bash-parent-death-lease-"));
		const marker = join(dir, "target.pid");
		const fixture = fileURLToPath(new URL("./fixtures/parent-death-guard-lease-host.ts", import.meta.url));
		const tsxLoader = createRequire(import.meta.url).resolve("tsx/esm");
		const host = spawn(process.execPath, ["--import", tsxLoader, fixture, marker], {
			cwd: dir,
			stdio: "ignore",
		});
		let targetPid = 0;

		try {
			await waitUntil(() => {
				try {
					targetPid = Number.parseInt(readFileSync(marker, "utf8").trim(), 10);
					return Number.isFinite(targetPid) && targetPid > 0 && isAlive(targetPid);
				} catch {
					return false;
				}
			}, 5000);

			host.kill("SIGKILL");
			await waitUntil(() => !isAlive(targetPid), 6000);
			expect(isAlive(targetPid)).toBe(false);
		} finally {
			if (host.pid && isAlive(host.pid)) host.kill("SIGKILL");
			if (targetPid && isAlive(targetPid)) {
				try {
					process.kill(-targetPid, "SIGKILL");
				} catch {
					// Already gone.
				}
			}
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not release a command canceled while guardian registration is pending", async () => {
		const { existsSync, mkdtempSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = mkdtempSync(join(tmpdir(), "bash-parent-death-cancel-"));
		const marker = join(dir, "must-not-run");
		const controller = new AbortController();

		try {
			const operations = createLocalBashOperations({ parentDeathGuard: true });
			const execution = operations.exec(`touch ${marker}`, dir, {
				onData: () => undefined,
				signal: controller.signal,
			});
			controller.abort("user stopped");

			await expect(execution).rejects.toThrow("aborted");
			expect(existsSync(marker)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("preserves the original PowerShell script as the shell command", async () => {
		const { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = mkdtempSync(join(tmpdir(), "bash-parent-death-pwsh-"));
		const fakePwsh = join(dir, "fake-pwsh");
		const marker = join(dir, "command.txt");
		const command = 'param([string]$Name)\n"hello $Name"';

		try {
			writeFileSync(
				fakePwsh,
				'#!/bin/sh\nfor argument do last="$argument"; done\nprintf "%s" "$last" > "$FAKE_PWSH_MARKER"\n',
			);
			chmodSync(fakePwsh, 0o755);
			const operations = createLocalBashOperations({ shellPath: fakePwsh, parentDeathGuard: true });
			await operations.exec(command, dir, {
				onData: () => undefined,
				env: { ...process.env, FAKE_PWSH_MARKER: marker },
			});

			expect(readFileSync(marker, "utf8")).toBe(command);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps FullLanguage Windows PowerShell setup outside the original script block", async () => {
		const { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = mkdtempSync(join(tmpdir(), "bash-parent-death-full-language-powershell-"));
		const fakePowerShell = join(dir, "fake-powershell");
		const marker = join(dir, "command.txt");
		const command = `#requires -Version 5.1\nusing namespace System.Text\nparam([string]$Name)\n#${"x".repeat(13_000)}\n"hello $Name"`;

		try {
			writeFileSync(
				fakePowerShell,
				[
					"#!/usr/bin/env node",
					'const fs = require("node:fs");',
					"const launcher = process.argv.at(-1);",
					'if (launcher === "$ExecutionContext.SessionState.LanguageMode") {',
					'  process.stdout.write("FullLanguage\\n");',
					"  process.exit(0);",
					"}",
					'process.stdin.setEncoding("utf8");',
					'let source = "";',
					'process.stdin.on("data", (chunk) => { source += chunk; });',
					'process.stdin.on("end", () => {',
					"  fs.writeFileSync(process.env.FAKE_POWERSHELL_MARKER, JSON.stringify({ launcher, source }));",
					"});",
				].join("\n"),
			);
			chmodSync(fakePowerShell, 0o755);
			const operations = createLocalBashOperations({ shellPath: fakePowerShell });
			await operations.exec(command, dir, {
				onData: () => undefined,
				env: { ...process.env, FAKE_POWERSHELL_MARKER: marker },
			});

			const captured = JSON.parse(readFileSync(marker, "utf8")) as { launcher: string; source: string };
			expect(captured.source).toBe(command);
			expect(captured.launcher).toContain("OutputEncoding");
			expect(captured.launcher).toContain("ScriptRequirements");
			expect(captured.launcher).toContain("RequiredPSVersion");
			expect(captured.launcher).toContain("RequiredModules");
			expect(captured.launcher).toContain("ScriptBlock]::Create");
			expect(captured.launcher).not.toContain("$__mavisSource");
			expect(captured.launcher).not.toContain(".ps1");
			expect(captured.launcher.length).toBeLessThan(8192);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("executes Windows PowerShell commands without restricted APIs in ConstrainedLanguage", async () => {
		const dir = mkdtempSync(join(tmpdir(), "bash-parent-death-powershell-"));
		const fakePowerShell = join(dir, "fake-powershell");
		const marker = join(dir, "command.txt");
		const command = `#requires -Version 5.1\nusing namespace System.Text\nparam([string]$Name)\n#${"x".repeat(13_000)}\n"你好 $Name"`;

		try {
			writeFileSync(
				fakePowerShell,
				[
					"#!/usr/bin/env node",
					'const fs = require("node:fs");',
					"const launcher = process.argv.at(-1);",
					'if (launcher === "$ExecutionContext.SessionState.LanguageMode") {',
					'  process.stdout.write("ConstrainedLanguage\\n");',
					"  process.exit(0);",
					"}",
					'const transport = launcher.match(/\\$env:([A-Z0-9_]+)/)?.[1];',
					"const source = transport ? process.env[transport] : undefined;",
					"const forbidden = [",
					'  "[Console]::",',
					'  "Parser]::ParseInput",',
					'  "ScriptBlock]::Create",',
					"].filter((value) => launcher.includes(value));",
					"fs.writeFileSync(",
					"  process.env.FAKE_POWERSHELL_MARKER,",
					"  JSON.stringify({ launcher, source, forbidden }),",
					");",
					"process.exit(forbidden.length || !source ? 1 : 0);",
				].join("\n"),
			);
			chmodSync(fakePowerShell, 0o755);
			const operations = createLocalBashOperations({ shellPath: fakePowerShell, parentDeathGuard: true });
			const result = await operations.exec(command, dir, {
				onData: () => undefined,
				env: { ...process.env, FAKE_POWERSHELL_MARKER: marker },
			});

			const captured = JSON.parse(readFileSync(marker, "utf8")) as {
				launcher: string;
				source: string;
				forbidden: string[];
			};
			expect(result.exitCode).toBe(0);
			expect(captured.source).toBe(command);
			expect(captured.forbidden).toEqual([]);
			expect(captured.launcher).toContain("Invoke-Expression");
			expect(captured.launcher).not.toContain("$__mavisSource");
			expect(captured.launcher).not.toContain(".ps1");
			expect(captured.launcher.length).toBeLessThan(1024);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not apply NODE_OPTIONS to the guarded launcher", async () => {
		let output = "";
		const operations = createLocalBashOperations({ parentDeathGuard: true });
		const result = await operations.exec("echo OK", process.cwd(), {
			onData: (chunk) => {
				output += chunk.toString("utf8");
			},
			env: { ...process.env, NODE_OPTIONS: "--require=./missing-launcher-hook.cjs" },
		});

		expect(result.exitCode).toBe(0);
		expect(output.trim()).toBe("OK");
	});

	it("does not resolve the Unix guardian gate through the command PATH", async () => {
		const { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = mkdtempSync(join(tmpdir(), "bash-parent-death-path-"));
		const fakeSh = join(dir, "sh");
		const marker = join(dir, "fake-sh-ran");
		let output = "";

		try {
			writeFileSync(fakeSh, '#!/bin/sh\n: > "$FAKE_SH_MARKER"\nexit 99\n');
			chmodSync(fakeSh, 0o755);
			const operations = createLocalBashOperations({ shellPath: "/bin/bash", parentDeathGuard: true });
			const result = await operations.exec("printf OK", dir, {
				onData: (chunk) => {
					output += chunk.toString("utf8");
				},
				env: { PATH: dir, FAKE_SH_MARKER: marker },
			});

			expect(result.exitCode).toBe(0);
			expect(output).toBe("OK");
			expect(existsSync(marker)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps the user shell as its Unix process-group leader", async () => {
		let output = "";
		const operations = createLocalBashOperations({ parentDeathGuard: true });
		const result = await operations.exec('printf "%s %s" "$$" "$(ps -o pgid= -p $$ | tr -d " ")"', process.cwd(), {
			onData: (chunk) => {
				output += chunk.toString("utf8");
			},
		});
		const [shellPid, processGroupId] = output.trim().split(" ");

		expect(result.exitCode).toBe(0);
		expect(shellPid).toBe(processGroupId);
	});

	it("captures shell diagnostics emitted immediately after guarded launch", async () => {
		let output = "";
		const operations = createLocalBashOperations({ shellPath: "/bin/bash", parentDeathGuard: true });
		const result = await operations.exec("if then", process.cwd(), {
			onData: (chunk) => {
				output += chunk.toString("utf8");
			},
		});

		expect(result.exitCode).toBe(2);
		expect(output.toLowerCase()).toMatch(/syntax|unexpected/);
	});

	it("keeps guarded output open until delayed TERM cleanup finishes", async () => {
		let output = "";
		const controller = new AbortController();
		const operations = createLocalBashOperations({ parentDeathGuard: true });
		const execution = operations.exec(
			"trap 'sleep 0.3; echo DELAYED-CLEANUP; exit 0' TERM; echo READY; while true; do sleep 0.05; done",
			process.cwd(),
			{
				onData: (chunk) => {
					output += chunk.toString("utf8");
				},
				signal: controller.signal,
			},
		);
		await waitUntil(() => output.includes("READY"), 3000);
		controller.abort("user stopped");

		await expect(execution).rejects.toThrow("aborted");
		expect(output).toContain("DELAYED-CLEANUP");
	});
});
