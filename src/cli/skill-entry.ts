#!/usr/bin/env node
import { runSkill } from "./skill.js";

runSkill(process.argv.slice(2)).catch((err: unknown) => {
  console.error("[skill] Fatal error:", err);
  process.exit(1);
});
