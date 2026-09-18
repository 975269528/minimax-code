import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeBashWithOperations } from "../src/core/bash-executor.ts";
import { createBashTool, createLocalBashOperations } from "../src/core/tools/bash.ts";

function toBashSingleQuotedArg(value: string): string {
	return `'${value.replace(/\\/g, "/").replace(/'/g, `'"'"'`)}'`;
}

function createInheritedStdioCommand(pidFile: string): string {
	const pidFileArg = toBashSingleQuotedArg(pidFile);
	return (
		'node -e "' +
		"const fs=require('fs');" +
		"const {spawn}=require('child_process');" +
		"const child=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'inherit',detached:true});" +
		"fs.writeFileSync(process.argv[1], String(child.pid));" +
		"child.unref();" +
		"console.log('child-exiting');" +
		'" ' +
		pidFileArg
	);
}

function cleanupDetachedChild(pidFile: string): void {
	if (!existsSync(pidFile)) {
		return;
	}

	const pid = Number.parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
	if (Number.isFinite(pid) && pid > 0) {
		try {
			execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
		} catch {
			// Process may have already exited.
		}
	}
}

async function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timeoutId = setTimeout(() => {
			onTimeout();
			reject(new Error(`Timed out after ${ms}ms`));
		}, ms);

		promise.then(
			(value) => {
				clearTimeout(timeoutId);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timeoutId);
				reject(error);
			},
		);
	});
}

function getTextOutput(result: { content?: Array<{ type: string; text?: string }> }): string {
	return (
		result.content
			?.filter((block) => block.type === "text")
			.map((block) => block.text ?? "")
			.join("\n") ?? ""
	);
}

describe.skipIf(process.platform !== "win32")("Windows child-process close handling", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `coding-agent-bash-close-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("executeBash resolves after the shell exits even if inherited stdio handles stay open", async () => {
		const pidFile = join(testDir, "executor-grandchild.pid");
		const command = createInheritedStdioCommand(pidFile);
		const controller = new AbortController();

		try {
			const result = await withTimeout(
				executeBashWithOperations(command, process.cwd(), createLocalBashOperations(), {
					signal: controller.signal,
				}),
				3000,
				() => {
					controller.abort();
				},
			);

			expect(result.output).toContain("child-exiting");
			expect(result.exitCode).toBe(0);
			expect(result.cancelled).toBe(false);
		} finally {
			controller.abort();
			cleanupDetachedChild(pidFile);
		}
	});

	it("bash tool resolves after the shell exits even if inherited stdio handles stay open", async () => {
		const pidFile = join(testDir, "tool-grandchild.pid");
		const command = createInheritedStdioCommand(pidFile);
		const controller = new AbortController();
		const bashTool = createBashTool(testDir);

		try {
			const result = await withTimeout(bashTool.execute("test-call", { command }, controller.signal), 3000, () => {
				controller.abort();
			});

			expect(getTextOutput(result)).toContain("child-exiting");
		} finally {
			controller.abort();
			cleanupDetachedChild(pidFile);
		}
	});

	it("times out cleanly when PATH cannot resolve taskkill", async () => {
		const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
		const originalPath = process.env[pathKey];
		process.env[pathKey] = "C:\\path-without-system32";

		try {
			const operations = createLocalBashOperations();
			await expect(
				operations.exec("Start-Sleep -Seconds 30", testDir, {
					onData: () => {},
					timeout: 0.2,
				}),
			).rejects.toThrow("timeout:0.2");

			await expect(
				operations.exec("Write-Output 'runtime-alive'", testDir, {
					onData: () => {},
				}),
			).resolves.toEqual({ exitCode: 0 });
		} finally {
			if (originalPath === undefined) {
				delete process.env[pathKey];
			} else {
				process.env[pathKey] = originalPath;
			}
		}
	});

	it("checks PowerShell 5 requirements before executing command side effects", async () => {
		const systemRoot = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
		const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
		const operations = createLocalBashOperations({ shellPath: powershell });

		for (const [name, requirement] of [
			["version", "#requires -Version 999"],
			["module", "#requires -Modules DefinitelyMissingMavisModule"],
		] as const) {
			const marker = join(testDir, `${name}-must-not-run.txt`);
			const quotedMarker = marker.replaceAll("'", "''");
			let output = "";
			const result = await operations.exec(
				`${requirement}\nSet-Content -LiteralPath '${quotedMarker}' -Value 'SHOULD_NOT_RUN'`,
				testDir,
				{
					onData: (chunk) => {
						output += chunk.toString("utf8");
					},
				},
			);

			expect(result.exitCode).not.toBe(0);
			expect(existsSync(marker)).toBe(false);
			expect(output.toLowerCase()).toMatch(/required|module/);
		}
	});

	it("does not expose fixed launcher variables to the PowerShell command", async () => {
		const systemRoot = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
		const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
		const operations = createLocalBashOperations({ shellPath: powershell });
		let output = "";
		const result = await operations.exec(
			"if ($null -eq (Get-Variable -Name '__mavisSource' -ErrorAction SilentlyContinue)) { 'clean' } else { throw 'polluted' }",
			testDir,
			{
				onData: (chunk) => {
					output += chunk.toString("utf8");
				},
			},
		);

		expect(result.exitCode).toBe(0);
		expect(output).toContain("clean");
	});
});
