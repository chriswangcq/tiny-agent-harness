import { describe, it, expect } from "vitest";
import { cleanEnv, buildCliTerminalEnv } from "../src/cli/terminal-env.js";

describe("cleanEnv", () => {
  it("keeps string values", () => {
    const result = cleanEnv({ PATH: "/usr/bin", HOME: "/home/user" });
    expect(result).toEqual({ PATH: "/usr/bin", HOME: "/home/user" });
  });

  it("drops undefined values", () => {
    const result = cleanEnv({ PATH: "/usr/bin", GONE: undefined as unknown as string } as NodeJS.ProcessEnv);
    expect(result).toEqual({ PATH: "/usr/bin" });
    expect("GONE" in result).toBe(false);
  });
});

describe("buildCliTerminalEnv", () => {
  it("sets TAH_RUN_CHANNEL when absent", () => {
    const result = buildCliTerminalEnv({ PATH: "/usr/bin" }, "default");
    expect(result.TAH_RUN_CHANNEL).toBe("default");
    expect(result.PATH).toBe("/usr/bin");
  });

  it("overwrites existing TAH_RUN_CHANNEL", () => {
    const result = buildCliTerminalEnv({ PATH: "/bin", TAH_RUN_CHANNEL: "stale" }, "default");
    expect(result.TAH_RUN_CHANNEL).toBe("default");
    expect(result.PATH).toBe("/bin");
  });

  it("injects current run identity and run-scoped paths", () => {
    const result = buildCliTerminalEnv({}, "default", {
      runId: "run-123",
      runDir: "/repo/.tiny-agent/runs/run-123",
      imDir: "/repo/.tiny-agent/runs/run-123/im",
      skillRunsDir: "/repo/.tiny-agent/runs/run-123/skill-runs",
      sessionsDir: "/repo/.tiny-agent/runs/run-123/sessions",
      skillsDir: "/repo/.tiny-agent/skills",
      transcriptPath: "/repo/.tiny-agent/runs/run-123/transcript.jsonl",
      environmentEventsPath: "/repo/.tiny-agent/runs/run-123/environment/events.jsonl",
    });

    expect(result).toMatchObject({
      TAH_RUN_CHANNEL: "default",
      TAH_RUN_ID: "run-123",
      TAH_RUN_DIR: "/repo/.tiny-agent/runs/run-123",
      TAH_STATE_DIR: "/repo/.tiny-agent/runs/run-123",
      TAH_IM_DIR: "/repo/.tiny-agent/runs/run-123/im",
      TAH_SKILL_RUNS_DIR: "/repo/.tiny-agent/runs/run-123/skill-runs",
      TAH_SESSIONS_DIR: "/repo/.tiny-agent/runs/run-123/sessions",
      TAH_SKILLS_DIR: "/repo/.tiny-agent/skills",
      TAH_TRANSCRIPT_PATH: "/repo/.tiny-agent/runs/run-123/transcript.jsonl",
      TAH_ENVIRONMENT_EVENTS_PATH:
        "/repo/.tiny-agent/runs/run-123/environment/events.jsonl",
    });
  });

  it("uses different channels", () => {
    const result = buildCliTerminalEnv({}, "cli");
    expect(result.TAH_RUN_CHANNEL).toBe("cli");
  });

  it("drops undefined env values", () => {
    const result = buildCliTerminalEnv({ PATH: "/bin", GONE: undefined as unknown as string } as NodeJS.ProcessEnv, "default");
    expect(result.PATH).toBe("/bin");
    expect("GONE" in result).toBe(false);
    expect(result.TAH_RUN_CHANNEL).toBe("default");
  });
});
