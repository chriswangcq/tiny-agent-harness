import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  executeSkillClientArgv,
  type SkillCliDeps,
} from "../src/cli/skill.js";
import {
  createSkillHostExecutor,
  listenSkillHostSocket,
  requestSkillHostSocket,
  type SkillHostResponse,
} from "../src/skill/host.js";
import { launchSkillHost } from "../src/skill/launcher.js";

function makeClientDeps(options?: {
  env?: Record<string, string | undefined>;
  requestHost?: SkillCliDeps["requestHost"];
}): {
  deps: SkillCliDeps;
  stdout: () => string;
  stderr: () => string;
} {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  return {
    deps: {
      stdout: {
        write(text: string) {
          stdoutChunks.push(text);
          return undefined;
        },
      },
      stderr: {
        write(text: string) {
          stderrChunks.push(text);
          return undefined;
        },
      },
      env: options?.env ?? {},
      cwd: "/repo",
      timeoutMs: 1000,
      newRequestId: () => "skill-test-req",
      requestHost:
        options?.requestHost ??
        (async () => {
          throw new Error("requestHost should be injected by this test");
        }),
    },
    stdout: () => stdoutChunks.join(""),
    stderr: () => stderrChunks.join(""),
  };
}

describe("skill host-only CLI", () => {
  it("launches a run-owned skill-host with explicit metadata", async () => {
    let startInput: unknown;
    let killSignal: NodeJS.Signals | number | undefined;
    const socketPath = "/tmp/ta-rh/skill-1234567890abcdef.sock";
    const child = {
      pid: 123,
      killed: false,
      exitCode: null,
      stdin: null,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill(signal?: NodeJS.Signals | number) {
        killSignal = signal;
        this.killed = true;
        return true;
      },
      once() {
        return this;
      },
    };

    const launched = await launchSkillHost({
      supervisor: {
        startProcess(input) {
          startInput = input;
          return { process: {} as never, child };
        },
      },
      processId: "skill-host:run-1",
      owner: { scope: "run", runId: "run-1" },
      executable: "node",
      args: ["dist/cli/main.js", "skill", "host", "--socket", socketPath],
      cwd: "/repo",
      env: {},
      socketPath,
      skillsDir: "/state/skills",
      skillRunsDir: "/state/runs/run-1/skill-runs",
      startupTimeoutMs: 10,
      nowEpochMs: () => 0,
      wait: async () => {},
      isSocketReady: () => true,
    });

    expect(startInput).toMatchObject({
      kind: "skill-host",
      owner: { scope: "run", runId: "run-1" },
      args: ["dist/cli/main.js", "skill", "host", "--socket", socketPath],
      metadata: {
        runId: "run-1",
        socketPath,
        skillsDir: "/state/skills",
        skillRunsDir: "/state/runs/run-1/skill-runs",
      },
    });

    await launched.dispose();
    expect(killSignal).toBe("SIGTERM");
  });

  it("fails without an explicit run-scoped host socket", async () => {
    const h = makeClientDeps();

    const rc = await executeSkillClientArgv(["list", "--json"], h.deps);

    expect(rc).toBe(1);
    expect(h.stderr()).toBe("");
    const envelope = JSON.parse(h.stdout()) as Record<string, unknown>;
    expect(envelope).toMatchObject({
      ok: false,
      tool: "skill",
      errorCode: "SKILL_HOST_NOT_FOUND",
    });
  });

  it("routes public argv to the configured skill host socket", async () => {
    let captured: unknown;
    const h = makeClientDeps({
      env: { TAH_SKILL_HOST_SOCKET: "/tmp/skill-host.sock" },
      requestHost: async (request): Promise<SkillHostResponse> => {
        captured = request;
        return {
          schemaVersion: 1,
          id: request.request.id,
          ok: true,
          type: "skill.execute.result",
          exitCode: 0,
          stdout: "{\"ok\":true}\n",
          stderr: "",
        };
      },
    });

    const rc = await executeSkillClientArgv(["list", "--json"], h.deps);

    expect(rc).toBe(0);
    expect(h.stdout()).toBe("{\"ok\":true}\n");
    expect(captured).toMatchObject({
      socketPath: "/tmp/skill-host.sock",
      request: {
        schemaVersion: 1,
        id: "skill-test-req",
        type: "skill.execute",
        argv: ["list", "--json"],
      },
    });
  });

  it("executes skill commands through a real resident socket", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-host-test-"));
    const socketPath = path.join(dir, "skill-host.sock");
    const skillsDir = path.join(dir, "skills");
    const skillRunsDir = path.join(dir, "skill-runs");
    fs.mkdirSync(skillsDir, { recursive: true });
    const executor = createSkillHostExecutor({
      cwd: dir,
      env: {
        TAH_STATE_DIR: dir,
        TAH_SKILLS_DIR: skillsDir,
        TAH_SKILL_RUNS_DIR: skillRunsDir,
        TAH_ENVIRONMENT_EVENTS_PATH: path.join(dir, "environment", "events.jsonl"),
      },
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
    });
    const server = await listenSkillHostSocket({ socketPath, executor });

    try {
      const response = await requestSkillHostSocket({
        socketPath,
        timeoutMs: 1000,
        request: {
          schemaVersion: 1,
          id: "list-1",
          type: "skill.execute",
          argv: ["list", "--json"],
        },
      });

      expect(response).toMatchObject({
        schemaVersion: 1,
        id: "list-1",
        ok: true,
        type: "skill.execute.result",
        exitCode: 0,
      });
      if (response.type === "skill.execute.result") {
        const envelope = JSON.parse(response.stdout) as Record<string, unknown>;
        expect(envelope).toMatchObject({
          ok: true,
          tool: "skill",
          skills: [],
        });
      }
    } finally {
      await server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
