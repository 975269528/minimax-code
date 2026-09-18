import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { whichSync } from "../third_party/sandbox-runtime/src/utils/which.js";

it("finds executable files without starting an external command", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mcode-executable-"));
  try {
    const name = process.platform === "win32" ? "fixture.EXE" : "fixture";
    const executable = path.join(dir, name);
    writeFileSync(executable, "fixture");
    chmodSync(executable, 0o700);
    expect(whichSync(name, dir)).toBe(executable);
    expect(whichSync(executable, "")).toBe(executable);
    mkdirSync(path.join(dir, "directory"));
    expect(whichSync("directory", dir)).toBeNull();
    expect(whichSync("missing", dir)).toBeNull();
    expect(whichSync("", dir)).toBeNull();
    expect(whichSync("bad\0name", dir)).toBeNull();
    if (process.platform !== "win32") {
      chmodSync(executable, 0o600);
      expect(whichSync(name, dir)).toBeNull();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
