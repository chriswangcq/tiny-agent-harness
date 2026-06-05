#!/usr/bin/env node
import { runTeam } from "./team-run.js";

runTeam(process.argv.slice(2)).catch((err: unknown) => {
  console.error("[team] Fatal error:", err);
  process.exit(1);
});
