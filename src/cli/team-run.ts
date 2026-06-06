import {
  createTeamServiceState,
  executeTeamCommand,
  HELP_TEXT,
  type TeamCliPorts,
} from "../subagent/team-cli.js";
import {
  createLifecycleServiceState,
  executeLifecycleCommand,
  type LifecycleCliPorts,
} from "../subagent/lifecycle-cli.js";
import { CAPABILITY_VERSIONS } from "./envelope.js";

// Register team tool version
CAPABILITY_VERSIONS["team"] = "0.1.0";

// Real clock/id ports — only at the CLI boundary
const realPorts: TeamCliPorts = {
  nowIso: () => new Date().toISOString(),
  newEventId: (prefix: string, seed: string) =>
    `${prefix}-${Date.now()}-${seed}`,
};

// Lifecycle-compatible ports (same shape)
const lifecyclePorts: LifecycleCliPorts = {
  nowIso: () => new Date().toISOString(),
  newEventId: (prefix: string) =>
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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

  // Route lifecycle group to its own handler
  if (group === "lifecycle") {
    const state = createLifecycleServiceState();
    const lifecycleArgs = args.slice(1);
    const result = executeLifecycleCommand(lifecyclePorts, state, lifecycleArgs, cwd);
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
