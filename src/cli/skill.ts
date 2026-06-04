import * as path from "node:path";
import * as fs from "node:fs";
import { SkillCli } from "../skill/cli.js";
import { SkillRunStore } from "../skill/store.js";
import { SkillDiscovery } from "../skill/discovery.js";
import type { EnvironmentPort, EnvironmentEvent } from "../types/environment.js";

function die(message: string): never {
  process.stderr.write(JSON.stringify({ ok: false, error: message }) + "\n");
  process.exit(1);
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

function resolveStateDir(argv: string[]): string {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--state-dir" && i + 1 < argv.length) {
      return argv[i + 1]!;
    }
  }
  if (process.env.TAH_STATE_DIR) {
    return process.env.TAH_STATE_DIR;
  }
  return path.resolve(".tiny-agent");
}

function buildSkillCli(stateDir: string): SkillCli {
  const skillsDir = process.env.TAH_SKILLS_DIR ?? path.join(stateDir, "skills");
  const skillRunsDir =
    process.env.TAH_SKILL_RUNS_DIR ?? path.join(stateDir, "skill-runs");
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.mkdirSync(skillRunsDir, { recursive: true });

  const store = new SkillRunStore({ skillRunsDir, skillsDir });
  const discovery = new SkillDiscovery({ skillsDir });

  const envEventsPath =
    process.env.TAH_ENVIRONMENT_EVENTS_PATH ??
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

function output(data: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify(data) + "\n");
  } else {
    process.stdout.write(formatHuman(data) + "\n");
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

export async function runSkill(argv: string[]): Promise<void> {
  const subcommand = argv[0];
  const rest = argv.slice(1);
  const jsonMode = hasFlag(rest, "json");
  const stateDir = resolveStateDir(rest);
  const { flags, positional } = parseArgs(rest);

  const cli = buildSkillCli(stateDir);
  switch (subcommand) {

    case "list": {
      output(cli.handleList(), jsonMode);
      break;
    }
    case "show": {
      const name = positional[0];
      if (!name) die("skill show requires <name>");
      output(cli.handleShow(name), jsonMode);
      break;
    }
    case "run": {
      const name = positional[0];
      if (!name) die("skill run requires <name>");
      const argsJson = positional[1];
      const args = argsJson ? JSON.parse(argsJson) : undefined;
      output(cli.handleRun(name, args), jsonMode);
      break;
    }
    case "status": {
      output(cli.handleStatus(), jsonMode);
      break;
    }
    case "close": {
      const skillRunId = positional[0];
      if (!skillRunId) die("skill close requires <skillRunId>");
      const review = (flags["review"] ?? "none") as "none" | "required";
      if (review !== "none" && review !== "required") {
        die("--review must be 'none' or 'required'");
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
      output(cli.handleClose(skillRunId, review, summary), jsonMode);
      break;
    }
    case "review-complete": {
      const skillRunId = positional[0];
      if (!skillRunId) die("skill review-complete requires <skillRunId>");
      const reviewJson = positional[1];
      if (!reviewJson) die("skill review-complete requires JSON review data");
      const reviewData = JSON.parse(reviewJson) as { summary: string; lessons: string[] };
      output(cli.handleReviewComplete(skillRunId, reviewData), jsonMode);
      break;
    }
    case "install": {
      const sourcePath = positional[0];
      if (!sourcePath) die("skill install requires <source-path>");
      const name = positional[1];
      output(cli.handleInstall(sourcePath, name || undefined), jsonMode);
      break;
    }
    case "validate": {
      const name = positional[0];
      if (!name) die("skill validate requires <name>");
      output(cli.handleValidate(name), jsonMode);
      break;
    }
    default:
      die(
        "Usage: skill <list|show|run|status|close|review-complete|validate|install> [options]\n" +
          "  skill list [--json]\n" +
          "  skill show <name> [--json]\n" +
          "  skill run <name> [--json '<args>']\n" +
          "  skill status [--active] [--json]\n" +
          "  skill close <skillRunId> --review none|required [--json '<summary>']\n" +
          "  skill review-complete <skillRunId> --json '<review>'\n" +
          "  skill validate <name> [--json]\n" +
          "  skill install <source-path> [<name>] [--json]",
      );
  }
}
