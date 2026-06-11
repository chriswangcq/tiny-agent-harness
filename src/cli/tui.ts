import * as fs from "node:fs";
import * as path from "node:path";
import { TuiController } from "../tui/controller.js";
import type { TuiControllerOptions } from "../tui/controller.js";
import { StateRootResolver } from "../state/root.js";
import {
  DEFAULT_RUN_USER_ENDPOINT,
  createRunImSelfEndpoint,
} from "../im/index.js";

export type TuiControllerOptionInput = {
  runDir: string;
  runsDir: string;
  stateRoot: string;
  runId: string;
  env?: Record<string, string | undefined>;
};

export function buildTuiControllerOptions(
  input: TuiControllerOptionInput,
): TuiControllerOptions {
  const selfEndpoint =
    input.env?.TAH_IM_SELF_ENDPOINT ?? createRunImSelfEndpoint(input.runId);
  const userEndpoint =
    input.env?.TAH_IM_USER_ENDPOINT ?? DEFAULT_RUN_USER_ENDPOINT;
  return {
    runDir: input.runDir,
    runsDir: input.runsDir,
    stateRoot: input.stateRoot,
    runId: input.runId,
    selfEndpoint,
    userEndpoint,
  };
}

export function runTui(args: string[]): void {
  // Parse --run flag
  let runId: string | undefined;
  let stateDir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--run" && i + 1 < args.length) {
      runId = args[i + 1];
    } else if (args[i] === "--state-dir" && i + 1 < args.length) {
      stateDir = args[i + 1];
    }
  }

  if (!runId) {
    console.error("[tiny-agent] Usage: tiny-agent tui --run <runId|latest> [--state-dir <dir>]");
    process.exit(1);
  }

  const baseDir = new StateRootResolver().resolve({ stateDir }).stateDir;
  const runsDir = path.join(baseDir, "runs");

  // Resolve "latest"
  let resolvedRunId: string = runId;
  if (runId === "latest") {
    const found = resolveLatestRun(runsDir);
    if (!found) {
      console.error("[tiny-agent] No runs found in", runsDir);
      process.exit(1);
    }
    resolvedRunId = found;
  }

  const runDir = path.join(runsDir, resolvedRunId);
  if (!fs.existsSync(runDir)) {
    console.error(`[tiny-agent] Run directory not found: ${runDir}`);
    process.exit(1);
  }

  const transcriptPath = path.join(runDir, "transcript.jsonl");
  if (!fs.existsSync(transcriptPath)) {
    console.error(`[tiny-agent] Transcript not found: ${transcriptPath}`);
    process.exit(1);
  }

  console.log(`[tiny-agent] Opening TUI for run: ${resolvedRunId}`);
  const controller = new TuiController(buildTuiControllerOptions({
    runDir,
    runsDir,
    stateRoot: baseDir,
    runId: resolvedRunId,
    env: process.env,
  }));
  controller.start();
}

function resolveLatestRun(runsDir: string): string | undefined {
  if (!fs.existsSync(runsDir)) return undefined;

  // Try symlink first
  const latestLink = path.join(runsDir, "latest");
  try {
    const target = fs.readlinkSync(latestLink);
    const resolved = path.isAbsolute(target) ? target : path.resolve(runsDir, target);
    if (fs.existsSync(resolved)) {
      return path.basename(resolved);
    }
  } catch {
    // not a symlink, try latest.json
  }

  // Try latest.json
  const latestJsonPath = path.join(runsDir, "latest.json");
  if (fs.existsSync(latestJsonPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(latestJsonPath, "utf-8")) as { runId?: string };
      if (data.runId) return data.runId;
    } catch {
      // ignore
    }
  }

  // Fall back to alphabetical sort (run IDs contain timestamps)
  const entries = fs.readdirSync(runsDir, { withFileTypes: true });
  const dirs = entries
    .filter(e => e.isDirectory() && e.name.startsWith("run-"))
    .map(e => e.name)
    .sort();

  return dirs.length > 0 ? dirs[dirs.length - 1] : undefined;
}
