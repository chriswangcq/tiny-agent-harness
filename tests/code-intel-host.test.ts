import { describe, expect, it } from "vitest";
import {
  createCodeIntelHostProcessRecord,
  handleCodeIntelHostRequest,
  parseCodeIntelHostRequest,
} from "../src/code-intel/index.js";
import { defaultConfig } from "../src/code-intel/config.js";
import type { CodeIntelRuntime } from "../src/code-intel/commands.js";

function makeRuntime(): CodeIntelRuntime {
  return {
    cwd: "/repo",
    workspaceRoot: "/repo",
    config: defaultConfig(),
    createBackend() {
      throw new Error("backend should not be used for capabilities");
    },
    collectWorkspaceDiagnostics() {
      return { diagnostics: [], truncated: false, omittedResults: 0 };
    },
  };
}

describe("code-intel host process planning", () => {
  it("creates project-owned codeq-host process records", () => {
    const record = createCodeIntelHostProcessRecord({
      projectId: "project-1",
      workspaceRoot: "/repo",
      now: "2026-06-11T00:00:00.000Z",
      executable: "tiny-agent",
      statePath: "/state/codeq/state.json",
      logPath: "/state/codeq/output.log",
    });

    expect(record).toMatchObject({
      id: "codeq-host:project-1:/repo",
      kind: "codeq-host",
      owner: {
        scope: "project",
        projectId: "project-1",
      },
      status: "planned",
      command: {
        executable: "tiny-agent",
        args: ["codeq", "host", "--cwd", "/repo"],
        cwd: "/repo",
      },
      metadata: {
        workspaceRoot: "/repo",
      },
    });
  });
});

describe("code-intel host protocol", () => {
  it("parses execute requests", () => {
    const request = parseCodeIntelHostRequest(
      JSON.stringify({
        schemaVersion: 1,
        id: "req-1",
        type: "codeq.execute",
        command: { kind: "capabilities" },
      }),
    );

    expect(request).toMatchObject({
      id: "req-1",
      type: "codeq.execute",
      command: { kind: "capabilities" },
    });
  });

  it("executes requests against an explicit runtime", async () => {
    const response = await handleCodeIntelHostRequest(makeRuntime(), {
      schemaVersion: 1,
      id: "req-1",
      type: "codeq.execute",
      command: { kind: "capabilities" },
    });

    expect(response).toMatchObject({
      schemaVersion: 1,
      id: "req-1",
      ok: true,
      type: "codeq.execute.result",
    });
    if (response.type === "codeq.execute.result") {
      expect(response.envelope.ok).toBe(true);
    }
  });
});
