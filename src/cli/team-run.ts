import {
  createTeamServiceState,
  executeTeamCommand,
  HELP_TEXT,
  type TeamCliPorts,
} from "../subagent/team-cli.js";
import { CAPABILITY_VERSIONS } from "./envelope.js";

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

  const state = createTeamServiceState();
  const cwd = process.cwd();
  const result = executeTeamCommand(realPorts, state, args, cwd);
  process.stdout.write(JSON.stringify(result));
  process.stdout.write("\n");
}
