import * as fs from "node:fs";
import * as path from "node:path";
import { failureEnvelope, successEnvelope } from "../cli/envelope.js";
import type { EnvironmentEvent, EnvironmentPort } from "../types/environment.js";
import { StateRootResolver } from "../state/root.js";
import { SkillCli } from "./cli.js";
import { SkillDiscovery } from "./discovery.js";
import { SkillRunStore } from "./store.js";

export type SkillCommandDeps = {
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  env: Record<string, string | undefined>;
  cwd: string;
};

export function defaultSkillCommandDeps(): SkillCommandDeps {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    cwd: process.cwd(),
  };
}

function parseArgs(argv: string[]): { flags: Record<string, string>; positional: string[] } {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") {
      continue;
    }
    if (arg.startsWith("--") && i + 1 < argv.length) {
      flags[arg.slice(2)] = argv[++i]!;
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

function resolveStateDir(argv: string[], deps: SkillCommandDeps): string {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--state-dir" && i + 1 < argv.length) {
      return path.resolve(deps.cwd, argv[i + 1]!);
    }
  }
  if (deps.env.TAH_STATE_DIR) {
    return path.resolve(deps.cwd, deps.env.TAH_STATE_DIR);
  }
  const homeDir = deps.env.HOME ?? deps.env.USERPROFILE ?? path.join(deps.cwd, ".home");
  return new StateRootResolver({
    env: { ...deps.env, TAH_STATE_DIR: undefined, TAH_PROJECT_STATE_DIR: undefined },
    cwd: () => deps.cwd,
    homeDir: () => homeDir,
  }).resolve().stateDir;
}

function buildSkillCli(stateDir: string, deps: SkillCommandDeps): SkillCli {
  const skillsDir = deps.env.TAH_SKILLS_DIR ?? path.join(stateDir, "skills");
  const skillRunsDir =
    deps.env.TAH_SKILL_RUNS_DIR ?? path.join(stateDir, "skill-runs");
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.mkdirSync(skillRunsDir, { recursive: true });

  const store = new SkillRunStore({ skillRunsDir, skillsDir });
  const discovery = new SkillDiscovery({ skillsDir });

  const envEventsPath =
    deps.env.TAH_ENVIRONMENT_EVENTS_PATH ??
    path.join(stateDir, "environment", "events.jsonl");
  const environment: EnvironmentPort = {
    appendEvent(event: EnvironmentEvent): void {
      const dir = path.dirname(envEventsPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(envEventsPath, JSON.stringify(event) + "\n", "utf-8");
    },
    consumeSince() { return []; },
    waitFor() { return new Promise(() => {}); },
  };

  return new SkillCli(store, discovery, environment, skillsDir);
}

function writeError(deps: SkillCommandDeps, message: string): number {
  const env = failureEnvelope({ tool: "skill", errorCode: "SKILL_ERROR", error: message });
  deps.stderr.write(JSON.stringify(env) + "\n");
  return 1;
}

function output(deps: SkillCommandDeps, data: unknown, json: boolean): void {
  if (json) {
    const raw = data as Record<string, unknown>;
    const isError = raw.ok === false;
    const envelope = isError
      ? failureEnvelope({ tool: "skill", errorCode: "SKILL_ERROR", error: String(raw.error ?? "unknown error") })
      : successEnvelope({ tool: "skill", extra: { ...raw } });
    deps.stdout.write(JSON.stringify(envelope) + "\n");
  } else {
    deps.stdout.write(formatHuman(data) + "\n");
  }
}

function formatHuman(data: unknown, indent = ""): string {
  if (data === null || data === undefined) return "";
  if (Array.isArray(data)) {
    return data.map((item, i) => `${indent}[${i}] ${formatHuman(item, indent + "  ")}`).join("\n");
  }
  if (typeof data === "object") {
    return Object.entries(data as Record<string, unknown>)
      .map(([k, v]) => {
        if (typeof v === "object" && v !== null) return `${indent}${k}:\n${formatHuman(v, indent + "  ")}`;
        return `${indent}${k}=${String(v)}`;
      })
      .join("\n");
  }
  return `${indent}${String(data)}`;
}

export function skillUsage(): string {
  return (
    "Usage: tiny-agent skill <list|show|run|status|close|review-complete|validate|install> [options]\n" +
    "Examples:\n" +
    "  tiny-agent skill list --json\n" +
    "  tiny-agent skill run code-review '{\"path\":\"src\"}' --json\n" +
    "  tiny-agent skill close skillrun-... --review required '{\"summary\":\"done\"}' --json\n"
  );
}

export async function executeSkillHostCommand(
  argv: string[],
  deps: SkillCommandDeps = defaultSkillCommandDeps(),
): Promise<number> {
  const subcommand = argv[0];
  const rest = argv.slice(1);

  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    deps.stdout.write(skillUsage());
    return 0;
  }

  const jsonMode = hasFlag(rest, "json");
  const stateDir = resolveStateDir(rest, deps);
  const { flags, positional } = parseArgs(rest);
  const cli = buildSkillCli(stateDir, deps);

  switch (subcommand) {
    case "list": {
      output(deps, cli.handleList(), jsonMode);
      return 0;
    }
    case "show": {
      const name = positional[0];
      if (!name) return writeError(deps, "tiny-agent skill show requires <name>");
      output(deps, cli.handleShow(name), jsonMode);
      return 0;
    }
    case "run": {
      const name = positional[0];
      if (!name) return writeError(deps, "tiny-agent skill run requires <name>");
      const argsJson = positional[1];
      const args = argsJson ? JSON.parse(argsJson) : undefined;
      output(deps, cli.handleRun(name, args), jsonMode);
      return 0;
    }
    case "status": {
      output(deps, cli.handleStatus(), jsonMode);
      return 0;
    }
    case "close": {
      const skillRunId = positional[0];
      if (!skillRunId) return writeError(deps, "tiny-agent skill close requires <skillRunId>");
      const review = (flags["review"] ?? "none") as "none" | "required";
      if (review !== "none" && review !== "required") {
        return writeError(deps, "--review must be 'none' or 'required'");
      }
      const summaryJson = positional[1];
      let summary = "";
      if (summaryJson) {
        try {
          const parsed = JSON.parse(summaryJson) as { summary?: string };
          summary = parsed.summary ?? summaryJson;
        } catch {
          summary = summaryJson;
        }
      }
      output(deps, cli.handleClose(skillRunId, review, summary), jsonMode);
      return 0;
    }
    case "review-complete": {
      const skillRunId = positional[0];
      if (!skillRunId) return writeError(deps, "tiny-agent skill review-complete requires <skillRunId>");
      const reviewJson = positional[1];
      if (!reviewJson) return writeError(deps, "tiny-agent skill review-complete requires JSON review data");
      const reviewData = JSON.parse(reviewJson) as { summary: string; lessons: string[] };
      output(deps, cli.handleReviewComplete(skillRunId, reviewData), jsonMode);
      return 0;
    }
    case "install": {
      const sourcePath = positional[0];
      if (!sourcePath) return writeError(deps, "tiny-agent skill install requires <source-path>");
      const name = positional[1];
      output(deps, cli.handleInstall(sourcePath, name || undefined), jsonMode);
      return 0;
    }
    case "validate": {
      const name = positional[0];
      if (!name) return writeError(deps, "tiny-agent skill validate requires <name>");
      output(deps, cli.handleValidate(name), jsonMode);
      return 0;
    }
    default:
      return writeError(deps, skillUsage());
  }
}
