import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  successEnvelope,
  failureEnvelope,
  CAPABILITY_VERSIONS,
} from "../src/cli/envelope.js";

// ---------------------------------------------------------------------------
// Helper: run tiny-agent CLI through compiled dist js
// ---------------------------------------------------------------------------
function runCli(args: string[]): { stdout: unknown; stderr: unknown } {
  const result = spawnSync(
    process.execPath,
    ["dist/cli/main.js", ...args],
    {
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  return {
    stdout: result.stdout && result.stdout.trim() ? JSON.parse(result.stdout.trim()) : null,
    stderr: result.stderr && result.stderr.trim() ? JSON.parse(result.stderr.trim()) : null,
  };
}

// ---------------------------------------------------------------------------
// Envelope helper tests (unit)
// ---------------------------------------------------------------------------
describe("envelope helpers", () => {
  describe("successEnvelope", () => {
    it("returns ok:true with tool and version", () => {
      const result = successEnvelope({
        tool: "im",
        extra: { id: "msg-001", channel: "test" },
      });
      expect(result.ok).toBe(true);
      expect(result.tool).toBe("im");
      expect(result.version).toBe(CAPABILITY_VERSIONS.im);
      expect((result as Record<string, unknown>).id).toBe("msg-001");
      expect((result as Record<string, unknown>).channel).toBe("test");
    });

    it("includes cwd when provided", () => {
      const result = successEnvelope({
        tool: "skill",
        cwd: "/tmp/test",
        extra: { skills: [] },
      });
      expect(result.cwd).toBe("/tmp/test");
      expect(result.tool).toBe("skill");
      expect(result.version).toBe(CAPABILITY_VERSIONS.skill);
    });

    it("works with empty extra", () => {
      const result = successEnvelope({ tool: "mcp" });
      expect(result.ok).toBe(true);
      expect(result.tool).toBe("mcp");
    });

    it("preserves nested data in extra", () => {
      const result = successEnvelope({
        tool: "im",
        extra: {
          ok: true,
          channel: "default",
          count: 3,
          messages: [{ id: "m1", text: "hello" }],
        },
      });
      expect((result as Record<string, unknown>).count).toBe(3);
      const msgs = (result as Record<string, unknown>).messages as Array<unknown>;
      expect(msgs).toHaveLength(1);
    });
  });

  describe("failureEnvelope", () => {
    it("returns ok:false with tool, version, errorCode, and error", () => {
      const result = failureEnvelope({
        tool: "im",
        errorCode: "IM_CURSOR_NOT_FOUND",
        error: "Cursor not found",
      });
      expect(result.ok).toBe(false);
      expect(result.tool).toBe("im");
      expect(result.version).toBe(CAPABILITY_VERSIONS.im);
      expect(result.errorCode).toBe("IM_CURSOR_NOT_FOUND");
      expect(result.error).toBe("Cursor not found");
    });

    it("includes cwd and details when provided", () => {
      const result = failureEnvelope({
        tool: "skill",
        cwd: "/tmp/test",
        errorCode: "SKILL_ERROR",
        error: "Skill not found: missing",
        details: { availableSkills: ["a", "b"] },
      });
      expect(result.cwd).toBe("/tmp/test");
      expect(result.details).toEqual({ availableSkills: ["a", "b"] });
    });
  });

  describe("CAPABILITY_VERSIONS", () => {
    it("has entries for im, skill, mcp, codeq", () => {
      expect(CAPABILITY_VERSIONS.im).toBeDefined();
      expect(CAPABILITY_VERSIONS.skill).toBeDefined();
      expect(CAPABILITY_VERSIONS.mcp).toBeDefined();
      expect(CAPABILITY_VERSIONS.codeq).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Real CLI boundary tests — IM
// ---------------------------------------------------------------------------
describe("IM CLI real output envelope", () => {
  it("success: im post produces envelope with tool, version, ok, id, channel", () => {
    const tmp = mkdtempSync(join(tmpdir(), "im-env-test-"));
    try {
      const result = runCli(["im", "post", "--json", "--channel", "test", "--text", "hello", "--state-dir", tmp]);
      const env = result.stdout as Record<string, unknown> | null;
      expect(env).not.toBeNull();
      expect(env!.ok).toBe(true);
      expect(env!.tool).toBe("im");
      expect(env!.version).toBeDefined();
      expect(env!.id).toBeDefined();
      expect(env!.channel).toBe("test");
    } finally {
      if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("error: im post without channel produces failure envelope on stderr", () => {
    const result = runCli(["im", "post", "--json"]);
    const stderr = result.stderr as Record<string, unknown> | null;
    expect(stderr).not.toBeNull();
    expect(stderr!.ok).toBe(false);
    expect(stderr!.tool).toBe("im");
    expect(stderr!.version).toBeDefined();
    expect(stderr!.errorCode).toBeDefined();
    expect(stderr!.error).toBeDefined();
  });

  it("success: im recv produces envelope with tool, ok, messages", () => {
    const tmp = mkdtempSync(join(tmpdir(), "im-env-test-"));
    try {
      runCli(["im", "post", "--json", "--channel", "test", "--text", "hi", "--state-dir", tmp]);
      const result = runCli(["im", "recv", "--json", "--channel", "test", "--state-dir", tmp]);
      const env = result.stdout as Record<string, unknown> | null;
      expect(env).not.toBeNull();
      expect(env!.ok).toBe(true);
      expect(env!.tool).toBe("im");
      expect(env!.version).toBeDefined();
      expect(env!.channel).toBe("test");
      expect(env!.count).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(env!.messages)).toBe(true);
    } finally {
      if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("Team CLI real output envelope", () => {
  it("persists team state and dispatches task assignment into run-scoped IM inbox", () => {
    const tmp = mkdtempSync(join(tmpdir(), "team-env-test-"));
    try {
      expect(runCli(["team", "create", "team-p6", "--state-dir", tmp]).stdout)
        .toMatchObject({ ok: true, tool: "team" });
      expect(
        runCli([
          "team",
          "member",
          "add",
          "coder-1",
          "coder",
          "worker-channel",
          "--state-dir",
          tmp,
        ]).stdout,
      ).toMatchObject({ ok: true, tool: "team" });
      expect(
        runCli([
          "team",
          "member",
          "update",
          "coder-1",
          "--json",
          '{"runId":"run-worker-1"}',
          "--state-dir",
          tmp,
        ]).stdout,
      ).toMatchObject({ ok: true, tool: "team" });
      expect(
        runCli([
          "team",
          "task",
          "create",
          "ticket-1",
          "Fix dispatch",
          "--state-dir",
          tmp,
        ]).stdout,
      ).toMatchObject({ ok: true, tool: "team" });

      const assigned = runCli([
        "team",
        "task",
        "assign",
        "ticket-1",
        "coder-1",
        "--text",
        "Please fix dispatch and report evidence.",
        "--state-dir",
        tmp,
      ]).stdout as Record<string, unknown>;

      expect(assigned).toMatchObject({
        ok: true,
        tool: "team",
        dispatch: {
          status: "sent",
          taskId: "ticket-1",
          memberId: "coder-1",
          channel: "worker-channel",
          runId: "run-worker-1",
        },
      });

      const inboxPath = join(
        tmp,
        "runs",
        "run-worker-1",
        "im",
        "worker-channel.inbox.jsonl",
      );
      const inbox = readFileSync(inboxPath, "utf-8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(inbox).toHaveLength(1);
      expect(inbox[0]).toMatchObject({
        channel: "worker-channel",
        role: "user",
        text: "Please fix dispatch and report evidence.",
      });

      const teamState = JSON.parse(
        readFileSync(join(tmp, "team", "state.json"), "utf-8"),
      ) as Record<string, any>;
      expect(teamState.taskState.tasks["ticket-1"].dispatch.status).toBe("sent");

      const teamEvents = readFileSync(join(tmp, "team", "events.jsonl"), "utf-8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, any>);
      expect(teamEvents.map((event) => event.kind)).toEqual([
        "team_created",
        "roster_event",
        "task_event",
        "roster_event",
        "task_event",
        "task_event",
        "task_event",
        "task_event",
      ]);
      expect(teamEvents.at(-1)).toMatchObject({
        kind: "task_event",
        event: { kind: "task_dispatch_sent" },
      });
    } finally {
      if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Real CLI boundary tests — Skill
// ---------------------------------------------------------------------------
describe("Skill CLI real output envelope", () => {
  it("success: skill list produces envelope with tool, ok, skills", () => {
    const tmp = mkdtempSync(join(tmpdir(), "skill-env-test-"));
    try {
      const result = runCli(["skill", "list", "--json", "--state-dir", tmp]);
      const env = result.stdout as Record<string, unknown> | null;
      expect(env).not.toBeNull();
      expect(env!.ok).toBe(true);
      expect(env!.tool).toBe("skill");
      expect(env!.version).toBeDefined();
      expect(Array.isArray(env!.skills)).toBe(true);
    } finally {
      if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("error: skill show nonexistent produces failure envelope on stdout", () => {
    const result = runCli(["skill", "show", "nonexistent-skill", "--json"]);
    const env = result.stdout as Record<string, unknown> | null;
    expect(env).not.toBeNull();
    expect(env!.ok).toBe(false);
    expect(env!.tool).toBe("skill");
    expect(env!.version).toBeDefined();
    expect(env!.error).toBeDefined();
  });

  it("success: skill status produces envelope with tool, activeRuns", () => {
    const tmp = mkdtempSync(join(tmpdir(), "skill-env-test-"));
    try {
      const result = runCli(["skill", "status", "--json", "--state-dir", tmp]);
      const env = result.stdout as Record<string, unknown> | null;
      expect(env).not.toBeNull();
      expect(env!.ok).toBe(true);
      expect(env!.tool).toBe("skill");
      expect(env!.version).toBeDefined();
      expect(Array.isArray(env!.activeRuns)).toBe(true);
    } finally {
      if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Real CLI boundary tests — MCP
// ---------------------------------------------------------------------------
describe("MCP CLI real output envelope", () => {
  it("success: mcp list produces envelope with tool, ok, servers", () => {
    const tmp = mkdtempSync(join(tmpdir(), "mcp-env-test-"));
    try {
      // --state-dir must come before subcommand per main.ts routing
      const result = runCli(["--state-dir", tmp, "mcp", "list", "--json"]);
      const env = result.stdout as Record<string, unknown> | null;
      expect(env).not.toBeNull();
      expect(env!.ok).toBe(true);
      expect(env!.tool).toBe("mcp");
      expect(env!.version).toBeDefined();
      expect(Array.isArray(env!.servers)).toBe(true);
    } finally {
      if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("error: mcp unknown command produces failure envelope on stderr", () => {
    const tmp = mkdtempSync(join(tmpdir(), "mcp-env-test-"));
    try {
      const result = runCli(["--state-dir", tmp, "mcp", "nonexistent-cmd", "--json"]);
      const stderr = result.stderr as Record<string, unknown> | null;
      expect(stderr).not.toBeNull();
      expect(stderr!.ok).toBe(false);
      expect(stderr!.tool).toBe("mcp");
      expect(stderr!.version).toBeDefined();
      expect(stderr!.error).toBeDefined();
    } finally {
      if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
    }
  });
});
