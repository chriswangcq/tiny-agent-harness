#!/usr/bin/env node
import { runIm } from "./im.js";

runIm(process.argv.slice(2)).catch((err: unknown) => {
  console.error("[im] Fatal error:", err);
  process.exit(1);
});
