#!/usr/bin/env node
// Extract ToolPolicy risk findings from a run transcript.
// Usage: node scripts/transcript-policy-findings.mjs --run <runId> [--json]
//        node scripts/transcript-policy-findings.mjs --run latest [--json]

import { readFileSync, existsSync } from "node:fs";
import { readdirSync } from "node:fs";
import { resolve, join } from "node:path";

const args = process.argv.slice(2);

let runId = null;
let json = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--run" && args[i + 1]) runId = args[++i];
  else if (args[i] === "--json") json = true;
}

if (!runId) {
  console.error("Usage: node scripts/transcript-policy-findings.mjs --run <runId|latest> [--json]");
  process.exit(1);
}

const tinyAgentDir = resolve(".tiny-agent");
const runsDir = join(tinyAgentDir, "runs");

if (runId === "latest") {
  const entries = readdirSync(runsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .reverse();
  runId = entries[0];
  if (!runId) {
    console.error("No runs found.");
    process.exit(1);
  }
}

const transcriptPath = join(runsDir, runId, "transcript.jsonl");
if (!existsSync(transcriptPath)) {
  console.error(`Transcript not found: ${transcriptPath}`);
  process.exit(1);
}

const raw = readFileSync(transcriptPath, "utf-8");
const lines = raw.trim().split("\n");

const allFindings = [];
for (const line of lines) {
  try {
    const event = JSON.parse(line);
    if (event.type !== "tool_reviewed") continue;
    const findings = event.decision?.findings;
    if (!findings || findings.length === 0) continue;
    for (const f of findings) {
      allFindings.push({
        stepIndex: event.stepIndex,
        code: f.code,
        severity: f.severity,
        message: f.message,
      });
    }
  } catch {
    // skip malformed lines
  }
}

if (json) {
  console.log(JSON.stringify({ runId, count: allFindings.length, findings: allFindings }, null, 2));
} else {
  console.log(`Run: ${runId}`);
  console.log(`Policy findings: ${allFindings.length}`);
  console.log("");
  if (allFindings.length === 0) {
    console.log("No ToolPolicy risk findings in this run.");
  } else {
    for (const f of allFindings) {
      const label = f.severity === "error" ? "ERROR" : f.severity === "warning" ? "WARN" : "INFO";
      console.log(`  [${label}] ${f.code} (step ${f.stepIndex})`);
      console.log(`          ${f.message}`);
      console.log("");
    }
  }
}
