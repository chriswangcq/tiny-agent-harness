import * as path from "node:path";
import {
  createTeamServiceState,
  executeTeamCommand,
  HELP_TEXT,
  type TeamCliPorts,
} from "../subagent/team-cli.js";
import {
  createNodeLifecycleCliAdapterPorts,
  executeLifecycleAdapterCommand,
} from "../subagent/lifecycle-cli-adapter.js";
import { CAPABILITY_VERSIONS } from "./envelope.js";
import { StateRootResolver } from "../state/root.js";

// Register team tool version
CAPABILITY_VERSIONS["team"] = "0.1.0";

// Real clock/id ports — only at the CLI boundary
const realPorts: TeamCliPorts = {
  nowIso: () => new Date().toISOString(),
  newEventId: (prefix: string, seed: string) =>
    `${prefix}-${Date.now()}-${seed}`,
};

export async function runTeam(args: string[]): Promise<void> {
  // Check for --help before anything else
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    process.stdout.write(HELP_TEXT);
    process.stdout.write("\n");
    return;
  }

  const group = args[0];
  const cwd = process.cwd();

  // Route lifecycle group to thin dispatcher
  if (group === "lifecycle") {
    const lifecycleArgs = args.slice(1);
    const stateRoot = isHelpRequest(lifecycleArgs) ? cwd : resolveTeamStateRoot();
    const result = await executeLifecycleAdapterCommand(
      createNodeLifecycleCliAdapterPorts(),
      lifecycleArgs,
      { stateRoot, cwd },
    );
    process.stdout.write(JSON.stringify(result));
    process.stdout.write("\n");
    return;
  }

  // Route contact/task through existing handler
  const state = createTeamServiceState();
  const result = executeTeamCommand(realPorts, state, args, cwd);
  process.stdout.write(JSON.stringify(result));
  process.stdout.write("\n");
}

function resolveTeamStateRoot(): string {
  if (process.env.TAH_PROJECT_STATE_DIR) {
    return path.resolve(process.env.TAH_PROJECT_STATE_DIR);
  }

  if (process.env.TAH_RUN_DIR) {
    const runDir = path.resolve(process.env.TAH_RUN_DIR);
    if (path.basename(path.dirname(runDir)) === "runs") {
      return path.dirname(path.dirname(runDir));
    }
  }

  if (process.env.TAH_STATE_DIR) {
    const stateDir = path.resolve(process.env.TAH_STATE_DIR);
    if (path.basename(path.dirname(stateDir)) !== "runs") {
      return stateDir;
    }
  }

  return new StateRootResolver({
    env: { ...process.env, TAH_STATE_DIR: undefined },
  }).resolve().stateDir;
}

function isHelpRequest(args: string[]): boolean {
  return args.length === 0 || args[0] === "--help" || args[0] === "-h";
}
