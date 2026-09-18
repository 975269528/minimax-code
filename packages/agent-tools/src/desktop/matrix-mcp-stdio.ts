#!/usr/bin/env node
import { runMatrixMcpStdioServer } from './matrix-mcp-server.js';

try {
  await runMatrixMcpStdioServer();
} catch (err) {
  const message = err instanceof Error ? err.stack || err.message : String(err);
  process.stderr.write(`[mavis-matrix-mcp-server] fatal ${message}\n`);
  process.exitCode = 1;
}
