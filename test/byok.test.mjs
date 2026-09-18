import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
// This fixture validates BYOK transport and real Runtime persistence, not model quality.
test(
  "BYOK runs without managed login and resumes its saved conversation",
  { timeout: 90000 },
  async (t) => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "minimax-code-byok-"));
    const dbPath = path.join(dataDir, "v2", "sqlite", "runtime-state.sqlite");
    mkdirSync(path.dirname(dbPath), { recursive: true });
    const legacyDb = new Database(dbPath);
    try {
      // An upgrade must ignore a previously enabled cloud-indexing preference.
      legacyDb.exec(`
        CREATE TABLE local_runtime_preferences (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
        INSERT INTO local_runtime_preferences VALUES ('workspace-indexing-enabled', 'true');
      `);
    } finally {
      legacyDb.close();
    }
    const requests = [];
    const readMarker = `ACTUAL_FILE_CONTENT_${Date.now()}`;
    writeFileSync(path.join(dataDir, "read-fixture.txt"), readMarker);
    let toolRequested = false;
    const networkAudit = path.join(dataDir, "network-audit.log");
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      requests.push({ url: req.url, auth: req.headers.authorization, body });
      if (!req.url?.endsWith("/chat/completions")) {
        res.writeHead(404).end();
        return;
      }
      if (!body.stream) {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            id: "fixture",
            object: "chat.completion",
            model: "fixture-model",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "LOCAL_BYOK_OK" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (
        JSON.stringify(body.messages).includes("TOOL_READ_TEST") &&
        !toolRequested
      ) {
        toolRequested = true;
        assert.ok(body.tools?.some((tool) => tool.function?.name === "read"));
        for (const delta of [
          {
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: "read-fixture-call",
                      type: "function",
                      function: {
                        name: "read",
                        arguments: JSON.stringify({
                          path: path.join(dataDir, "read-fixture.txt"),
                        }),
                      },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        ])
          res.write(
            `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model", ...delta })}\n\n`,
          );
        res.end("data: [DONE]\n\n");
        return;
      }
      for (const chunk of [
        {
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "LOCAL_BYOK_OK" },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
      ])
        res.write(
          `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model", ...chunk })}\n\n`,
        );
      res.end("data: [DONE]\n\n");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      try {
        assert.equal(
          existsSync(networkAudit),
          false,
          existsSync(networkAudit)
            ? readFileSync(networkAudit, "utf8")
            : "Unexpected external request",
        );
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    const env = {
      ...process.env,
      MINIMAX_DATA_DIR: dataDir,
      MAVIS_DATA_DIR: dataDir,
      MCODE_PROVIDER_API_KEY: "fixture-only-key",
      MCODE_TEST_ALLOWED_ORIGIN: new URL(baseUrl).origin,
      MCODE_TEST_NETWORK_AUDIT: networkAudit,
      MCODE_TEST_MANAGED_OFFLINE: "1",
      MCODE_TEST_PROCESS_PROBE: "1",
      NODE_OPTIONS: `--import=${new URL("./network-deny.mjs", import.meta.url).href}`,
      HTTP_PROXY: "",
      HTTPS_PROXY: "",
      ALL_PROXY: "",
    };
    let commandSequence = 0;
    async function run(args) {
      const startedAt = Date.now();
      const label = args.slice(0, 2).join(" ");
      const requestCountAtStart = requests.length;
      const diagnosticsDir = path.join(dataDir, `cli-diagnostics-${++commandSequence}`);
      const commandArgs = args[0] === "exec"
        ? [...args, "--diagnostics-dir", diagnosticsDir]
        : args;
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [cli, ...commandArgs], {
          cwd: dataDir,
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "",
          stderr = "";
        let timeoutError;
        const timer = setTimeout(() => {
          const progressPath = path.join(diagnosticsDir, "progress.jsonl");
          let progress = "No execution progress recorded";
          try {
            if (existsSync(progressPath))
              progress = readFileSync(progressPath, "utf8").slice(-12000);
          } catch (error) {
            progress = `Unable to read execution progress: ${error.message}`;
          }
          timeoutError = new Error(
            `Timed out after ${Date.now() - startedAt}ms: ${label}\n` +
            `Fixture requests during command: ${requests.length - requestCountAtStart}\n` +
            `stdout (tail): ${stdout.slice(-12000)}\nstderr (tail): ${stderr.slice(-12000)}\n` +
            `execution progress (tail): ${progress}`,
          );
          child.kill("SIGKILL");
          child.stdout.destroy();
          child.stderr.destroy();
        }, 35000);
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("close", (code) => {
          clearTimeout(timer);
          t.diagnostic(`${label}: exit ${code} after ${Date.now() - startedAt}ms`);
          if (timeoutError) {
            reject(timeoutError);
            return;
          }
          code === 0
            ? resolve(stdout)
            : reject(new Error(`CLI exited ${code}: ${stderr}\n${stdout}`));
        });
      });
    }
    await run([
      "provider",
      "add",
      "--name",
      "Fixture",
      "--base-url",
      baseUrl,
      "--api-format",
      "openai-completions",
      "--model",
      "fixture-model",
    ]);
    const snapshot = JSON.parse(await run(["provider", "list", "--json"]));
    assert.equal(
      snapshot.providers.some((p) => p.kind === "minimax-oauth"),
      true,
    );
    const selected = snapshot.providers.find(
      (p) => p.kind === "custom" && p.name === "Fixture",
    );
    assert.ok(selected?.hasApiKey);
    await run([
      "provider",
      "test",
      selected.providerId,
      "--model",
      "fixture-model",
    ]);
    const modelArgs = ["--model", `${selected.providerId}/fixture-model`];
    const first = await run([
      "exec",
      "Remember this marker: SOURCE_REPOSITORY_TEST",
      ...modelArgs,
      "--timeout",
      "20s",
      "--max-steps",
      "1",
    ]);
    assert.match(first, /LOCAL_BYOK_OK/);
    await assert.rejects(run([
      'exec', 'Managed model still requires its own login',
      '--model', 'minimax/MiniMax-M3', '--timeout', '20s', '--max-steps', '1',
    ]), /Sign in to MiniMax/);
    const beforeResume = requests.length;
    const second = await run([
      "exec",
      "Repeat the marker",
      ...modelArgs,
      "--continue",
      "--timeout",
      "20s",
      "--max-steps",
      "1",
    ]);
    assert.match(second, /LOCAL_BYOK_OK/);
    assert.ok(
      requests
        .slice(beforeResume)
        .some((r) =>
          JSON.stringify(r.body.messages ?? []).includes(
            "SOURCE_REPOSITORY_TEST",
          ),
        ),
      JSON.stringify(
        requests.map((r) => ({ url: r.url, keys: Object.keys(r.body) })),
      ),
    );
    const toolStart = requests.length;
    await run([
      "exec",
      "TOOL_READ_TEST: read read-fixture.txt",
      ...modelArgs,
      "--timeout",
      "20s",
      "--max-steps",
      "3",
    ]);
    assert.equal(toolRequested, true);
    assert.ok(
      requests
        .slice(toolStart)
        .some((r) =>
          r.body.messages?.some(
            (m) =>
              m.role === "tool" &&
              JSON.stringify(m.content).includes(readMarker),
          ),
        ),
      "The real read tool must return file contents to the provider",
    );
    assert.ok(requests.length >= 2);
    assert.ok(requests.every((r) => r.auth === "Bearer fixture-only-key"));
    assert.equal(
      requests.some((r) => r.body.tools?.some(
        (tool) => tool.function?.name === "workspace_semantic_search",
      )),
      false,
      "The retired workspace search tool must not be exposed to the model",
    );
    assert.equal(
      existsSync(path.join(dataDir, "v2", "workspaces")),
      false,
      "Startup, completed turns and resume must not create indexing artifacts",
    );
    const managedAudit = `${networkAudit}.managed`;
    assert.doesNotMatch(
      existsSync(managedAudit) ? readFileSync(managedAudit, "utf8") : "",
      /workspace-indexing/,
      "No workspace indexing request may be attempted",
    );
    const verificationDb = new Database(dbPath, { readonly: true });
    try {
      assert.deepEqual(
        verificationDb.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'local_runtime_workspace_indexing_%'",
        ).all(),
        [],
        "New runtime databases must not create the retired upload queue",
      );
    } finally {
      verificationDb.close();
    }
  },
);
