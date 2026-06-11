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
  it("preserves inherited env values and strips old IM channel variables", () => {
    const result = buildCliTerminalEnv({
      PATH: "/usr/bin",
      TAH_RUN_CHANNEL: "stale",
      TAH_IM_CHANNEL: "stale",
      TAH_IM_DIR: "/old/run/im",
    });
    expect(result.PATH).toBe("/usr/bin");
    expect(result).not.toHaveProperty("TAH_RUN_CHANNEL");
    expect(result).not.toHaveProperty("TAH_IM_CHANNEL");
    expect(result).not.toHaveProperty("TAH_IM_DIR");
  });

  it("injects current run identity and run-scoped paths", () => {
    const result = buildCliTerminalEnv({}, {
      runId: "run-123",
      runDir: "/repo/.tiny-agent/runs/run-123",
      projectStateDir: "/repo/.tiny-agent",
      imStateDir: "/repo/.tiny-agent",
      imSelfEndpoint: "run:run-123",
      imUserEndpoint: "user:main",
      skillRunsDir: "/repo/.tiny-agent/runs/run-123/skill-runs",
      sessionsDir: "/repo/.tiny-agent/runs/run-123/sessions",
      skillsDir: "/repo/.tiny-agent/skills",
      transcriptPath: "/repo/.tiny-agent/runs/run-123/transcript.jsonl",
      environmentEventsPath: "/repo/.tiny-agent/runs/run-123/environment/events.jsonl",
    });

    expect(result).toMatchObject({
      TAH_RUN_ID: "run-123",
      TAH_RUN_DIR: "/repo/.tiny-agent/runs/run-123",
      TAH_STATE_DIR: "/repo/.tiny-agent/runs/run-123",
      TAH_PROJECT_STATE_DIR: "/repo/.tiny-agent",
      TAH_IM_STATE_DIR: "/repo/.tiny-agent",
      TAH_IM_RUN_ID: "run-123",
      TAH_IM_SELF_ENDPOINT: "run:run-123",
      TAH_IM_USER_ENDPOINT: "user:main",
      TAH_SKILL_RUNS_DIR: "/repo/.tiny-agent/runs/run-123/skill-runs",
      TAH_SESSIONS_DIR: "/repo/.tiny-agent/runs/run-123/sessions",
      TAH_SKILLS_DIR: "/repo/.tiny-agent/skills",
      TAH_TRANSCRIPT_PATH: "/repo/.tiny-agent/runs/run-123/transcript.jsonl",
      TAH_ENVIRONMENT_EVENTS_PATH:
        "/repo/.tiny-agent/runs/run-123/environment/events.jsonl",
    });
  });

  it("drops undefined env values", () => {
    const result = buildCliTerminalEnv({ PATH: "/bin", GONE: undefined as unknown as string } as NodeJS.ProcessEnv);
    expect(result.PATH).toBe("/bin");
    expect("GONE" in result).toBe(false);
    expect(result).not.toHaveProperty("TAH_RUN_CHANNEL");
  });
});
