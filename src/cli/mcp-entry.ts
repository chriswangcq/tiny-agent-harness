#!/usr/bin/env node
import { runMcpCli } from "../mcp/cli.js";

runMcpCli(process.argv.slice(2))
  .then((rc) => {
    process.exitCode = rc;
  })
  .catch((err: unknown) => {
    console.error("[mcp] Fatal error:", err);
    process.exitCode = 1;
  });
