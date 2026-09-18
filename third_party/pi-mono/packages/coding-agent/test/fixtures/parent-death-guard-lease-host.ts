import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { armParentDeathGuard } from "../../src/utils/shell.ts";

const marker = process.argv[2];
if (!marker) throw new Error("marker path is required");

const target = spawn("/bin/bash", ["-c", "while true; do sleep 0.1; done"], {
	detached: true,
	stdio: "ignore",
});
if (!target.pid) throw new Error("target pid is required");

const firstLease = armParentDeathGuard(target.pid);
const secondLease = armParentDeathGuard(target.pid);
if (!firstLease || !secondLease) throw new Error("guardian leases are required");
await Promise.all([firstLease.ready, secondLease.ready]);
await firstLease.disarm();
writeFileSync(marker, String(target.pid));
setInterval(() => undefined, 60_000);
