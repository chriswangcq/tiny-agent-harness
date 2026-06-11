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
        extra: { id: "msg-001", from: "user:main", to: "member:team-p6/coder-1" },
      });
      expect(result.ok).toBe(true);
      expect(result.tool).toBe("im");
      expect(result.version).toBe(CAPABILITY_VERSIONS.im);
      expect((result as Record<string, unknown>).id).toBe("msg-001");
      expect((result as Record<string, unknown>).from).toBe("user:main");
      expect((result as Record<string, unknown>).to).toBe("member:team-p6/coder-1");
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
          from: "user:main",
          to: "member:team-p6/coder-1",
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
  it("success: im post produces envelope with tool, version, ok, id, and endpoints", () => {
    const tmp = mkdtempSync(join(tmpdir(), "im-env-test-"));
    try {
      const result = runCli([
        "im",
        "post",
        "--json",
        "--from",
        "user:main",
        "--to",
        "member:team-p6/coder-1",
        "--text",
        "hello",
        "--state-dir",
        tmp,
      ]);
      const env = result.stdout as Record<string, unknown> | null;
      expect(env).not.toBeNull();
      expect(env!.ok).toBe(true);
      expect(env!.tool).toBe("im");
      expect(env!.version).toBeDefined();
      expect(env!.id).toBeDefined();
      expect(env!.from).toBe("user:main");
      expect(env!.to).toBe("member:team-p6/coder-1");
    } finally {
      if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("error: im post without endpoints produces failure envelope on stderr", () => {
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
      runCli([
        "im",
        "post",
        "--json",
        "--from",
        "user:main",
        "--to",
        "member:team-p6/coder-1",
        "--text",
        "hi",
        "--state-dir",
        tmp,
      ]);
      const result = runCli([
        "im",
        "recv",
        "--json",
        "--as",
        "member:team-p6/coder-1",
        "--with",
        "user:main",
        "--state-dir",
        tmp,
      ]);
      const env = result.stdout as Record<string, unknown> | null;
      expect(env).not.toBeNull();
      expect(env!.ok).toBe(true);
      expect(env!.tool).toBe("im");
      expect(env!.version).toBeDefined();
      expect(env!.as).toBe("member:team-p6/coder-1");
      expect(env!.with).toBe("user:main");
      expect(env!.count).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(env!.messages)).toBe(true);
    } finally {
      if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("Team CLI real output envelope", () => {
  it("persists team roster state and uses IM for work instructions", () => {
    const tmp = mkdtempSync(join(tmpdir(), "team-env-test-"));
    try {
      expect(runCli(["team", "create", "team-p6", "--state-dir", tmp]).stdout)
        .toMatchObject({ ok: true, tool: "team" });
      expect(
        runCli([
          "team",
          "--team",
          "team-p6",
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
          "--team",
          "team-p6",
          "member",
          "update",
          "coder-1",
          "--json",
          '{"runId":"run-worker-1"}',
          "--state-dir",
          tmp,
        ]).stdout,
      ).toMatchObject({ ok: true, tool: "team" });

      const removedTaskCommand = runCli([
        "team",
        "--team",
        "team-p6",
        "task",
        "assign",
        "ticket-1",
        "coder-1",
        "--text",
        "Please fix dispatch and report evidence.",
        "--state-dir",
        tmp,
      ]).stdout as Record<string, unknown>;

      expect(removedTaskCommand).toMatchObject({
        ok: false,
        tool: "team",
        errorCode: "PARSE_ERROR",
      });

      expect(
        runCli([
          "im",
          "bind",
          "--json",
          "--state-dir",
          tmp,
          "--run-id",
          "run-worker-1",
          "--self",
          "member:team-p6/coder-1",
          "--peer",
          "user:main",
          "--kind",
          "a2user",
        ]).stdout,
      ).toMatchObject({ ok: true, tool: "im" });

      expect(
        runCli([
          "im",
          "post",
          "--json",
          "--state-dir",
          tmp,
          "--from",
          "user:main",
          "--to",
          "member:team-p6/coder-1",
          "--text",
          "Please fix dispatch and report evidence.",
        ]).stdout,
      ).toMatchObject({
        ok: true,
        tool: "im",
        from: "user:main",
        to: "member:team-p6/coder-1",
      });

      const runMessages = runCli([
        "im",
        "run-recv",
        "--json",
        "--state-dir",
        tmp,
        "--run-id",
        "run-worker-1",
      ]).stdout as Record<string, any>;
      expect(runMessages).toMatchObject({ ok: true, tool: "im", count: 1 });
      expect(runMessages.messages[0]).toMatchObject({
        from: "user:main",
        to: "member:team-p6/coder-1",
        role: "user",
        text: "Please fix dispatch and report evidence.",
      });

      const teamState = JSON.parse(
        readFileSync(join(tmp, "teams", "team-p6", "state.json"), "utf-8"),
      ) as Record<string, any>;
      expect(teamState).not.toHaveProperty("taskState");
      expect(teamState.roster.members["coder-1"]).toMatchObject({
        memberId: "coder-1",
        runId: "run-worker-1",
      });

      const teamEvents = readFileSync(join(tmp, "teams", "team-p6", "events.jsonl"), "utf-8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, any>);
      expect(teamEvents.map((event) => event.kind)).toEqual([
        "team_created",
        "roster_event",
        "roster_event",
      ]);
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

// ---------------------------------------------------------------------------
// Real CLI boundary tests — Code Intelligence
// ---------------------------------------------------------------------------
describe("Code intelligence CLI real output envelope", () => {
  it("success: codeq capabilities is routed through tiny-agent", () => {
    const tmp = mkdtempSync(join(tmpdir(), "codeq-env-test-"));
    try {
      const result = spawnSync(
        process.execPath,
        [join(process.cwd(), "dist/cli/main.js"), "codeq", "capabilities", "--json"],
        {
          cwd: tmp,
          encoding: "utf8",
          timeout: 15_000,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const env = result.stdout && result.stdout.trim()
        ? JSON.parse(result.stdout.trim()) as Record<string, unknown>
        : null;
      expect(env).not.toBeNull();
      expect(env!.ok).toBe(true);
      expect(env!.tool).toBe("codeq");
      expect(env!.version).toBeDefined();
      expect(env!.query).toMatchObject({ command: "capabilities" });
    } finally {
      if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
    }
  });
});
