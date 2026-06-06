import {
  createTeamServiceState,
  executeTeamCommand,
  HELP_TEXT,
  type TeamCliPorts,
} from "../subagent/team-cli.js";
import {
  executeLifecycleCommand,
  type LifecycleCliPorts,
} from "../subagent/lifecycle-cli.js";
import { lookupWorker } from "../subagent/contact-registry.js";
import { CAPABILITY_VERSIONS } from "./envelope.js";

// Register team tool version
CAPABILITY_VERSIONS["team"] = "0.1.0";

// Real clock/id ports — only at the CLI boundary
const realPorts: TeamCliPorts = {
  nowIso: () => new Date().toISOString(),
  newEventId: (prefix: string, seed: string) =>
    `${prefix}-${Date.now()}-${seed}`,
};

// Lifecycle-compatible ports
const lifecyclePorts: LifecycleCliPorts = {
  nowIso: () => new Date().toISOString(),
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

    // Build a fresh service state to provide worker lookups.
    // Lifecycle CLI does NOT own state — it delegates lifecycle
    // decisions to supervisor-lifecycle.ts and uses callbacks for data.
    const state = createTeamServiceState();
    const lookupWorkerFn = (workerId: string) =>
      lookupWorker(state.contactRegistry, workerId);

    const result = executeLifecycleCommand(
      lifecyclePorts,
      lifecycleArgs,
      cwd,
      lookupWorkerFn,
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
