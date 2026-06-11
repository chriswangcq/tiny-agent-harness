import * as path from "node:path";
import {
  HELP_TEXT,
} from "../subagent/team-cli.js";
import {
  createNodeTeamCliAdapterPorts,
  executeTeamAdapterCommand,
} from "../subagent/team-cli-adapter.js";
import {
  createNodeLifecycleCliAdapterPorts,
  executeLifecycleAdapterCommand,
} from "../subagent/lifecycle-cli-adapter.js";
import { CAPABILITY_VERSIONS } from "./envelope.js";
import { StateRootResolver } from "../state/root.js";

// Register team tool version
CAPABILITY_VERSIONS["team"] = "0.1.0";

export async function runTeam(args: string[]): Promise<void> {
  const options = parseTeamRunOptions(args);
  // Check for --help before anything else
  if (
    options.commandArgs.length === 0 ||
    options.commandArgs[0] === "--help" ||
    options.commandArgs[0] === "-h"
  ) {
    process.stdout.write(HELP_TEXT);
    process.stdout.write("\n");
    return;
  }

  const group = options.commandArgs[0];
  const cwd = process.cwd();

  // Route lifecycle group to thin dispatcher
  if (group === "lifecycle") {
    const lifecycleArgs = options.commandArgs.slice(1);
    const stateRoot = isHelpRequest(lifecycleArgs)
      ? cwd
      : resolveTeamStateRoot(options.stateDir);
    const result = await executeLifecycleAdapterCommand(
      createNodeLifecycleCliAdapterPorts(),
      lifecycleArgs,
      { stateRoot, cwd },
    );
    process.stdout.write(JSON.stringify(result));
    process.stdout.write("\n");
    return;
  }

  const result = await executeTeamAdapterCommand(
    createNodeTeamCliAdapterPorts(),
    options.commandArgs,
    { stateRoot: resolveTeamStateRoot(options.stateDir), cwd },
  );
  process.stdout.write(JSON.stringify(result));
  process.stdout.write("\n");
}

function resolveTeamStateRoot(explicitStateDir?: string): string {
  if (explicitStateDir) {
    return path.resolve(explicitStateDir);
  }

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

function parseTeamRunOptions(args: string[]): {
  commandArgs: string[];
  stateDir?: string;
} {
  const commandArgs: string[] = [];
  let stateDir: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--state-dir") {
      stateDir = args[index + 1];
      index += 1;
      continue;
    }
    if (arg !== undefined) {
      commandArgs.push(arg);
    }
  }

  return { commandArgs, stateDir };
}
