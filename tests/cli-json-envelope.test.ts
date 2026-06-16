import { describe, it, expect } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, existsSync, lstatSync, readFileSync, rmSync } from "node:fs";
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
function parseCliOutput(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return JSON.parse(trimmed);

  for (const line of trimmed.split(/\r?\n/).reverse()) {
    const candidate = line.trim();
    if (!candidate.startsWith("{") && !candidate.startsWith("[")) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // Keep scanning; non-JSON diagnostics can contain bracketed prefixes.
    }
  }
  return trimmed;
}

function runCli(args: string[], options?: { env?: NodeJS.ProcessEnv }): { stdout: unknown; stderr: unknown } {
  const result = spawnSync(
    process.execPath,
    ["dist/cli/main.js", ...args],
    {
      encoding: "utf8",
      env: options?.env,
      timeout: 15_000,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  return {
    stdout: parseCliOutput(result.stdout),
    stderr: parseCliOutput(result.stderr),
  };
}

async function waitForSocket(socketPath: string, child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(socketPath) && lstatSync(socketPath).isSocket()) {
      return;
    }
    if (child.exitCode !== null) {
      throw new Error(`runtime replica exited before socket was ready: ${socketPath}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for runtime replica socket: ${socketPath}`);
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
  it("error: removed IM admin path produces failure envelope and does not write IM files", () => {
    const tmp = mkdtempSync(join(tmpdir(), "im-env-test-"));
    try {
      const result = runCli([
        "im",
        "admin",
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
      const env = result.stderr as Record<string, unknown> | null;
      expect(env).not.toBeNull();
      expect(env!.ok).toBe(false);
      expect(env!.tool).toBe("im");
      expect(env!.version).toBeDefined();
      expect(env!.errorCode).toBe("IM_ERROR");
      expect(String(env!.error)).toContain("Usage: tiny-agent im");
      expect(existsSync(join(tmp, "im"))).toBe(false);
    } finally {
      if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("error: ordinary im post without runtime host socket produces failure envelope on stderr", () => {
    const result = runCli(["im", "post", "--json", "--text", "hello"]);
    const stderr = result.stderr as Record<string, unknown> | null;
    expect(stderr).not.toBeNull();
    expect(stderr!.ok).toBe(false);
    expect(stderr!.tool).toBe("im");
    expect(stderr!.version).toBeDefined();
    expect(stderr!.errorCode).toBe("RUNTIME_HOST_NOT_FOUND");
    expect(String(stderr!.error)).toContain("TAH_RUNTIME_HOST_SOCKET");
  });

  it("error: ordinary im post rejects direct --state-dir access", () => {
    const tmp = mkdtempSync(join(tmpdir(), "im-env-test-"));
    const forbiddenStateDirFlag = "--state" + "-dir";
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
        forbiddenStateDirFlag,
        tmp,
      ]);
      const stderr = result.stderr as Record<string, unknown> | null;
      expect(stderr).not.toBeNull();
      expect(stderr!.ok).toBe(false);
      expect(stderr!.tool).toBe("im");
      expect(stderr!.errorCode).toBe("IM_STATE_DIR_NOT_ALLOWED");
      expect(existsSync(join(tmp, "im"))).toBe(false);
    } finally {
      if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
    }
  });

});

describe("Team CLI real output envelope", () => {
  it("persists team roster state and uses an edge runtime replica for work instructions", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "team-env-test-"));
    const socketPath = join(tmpdir(), `tiny-agent-edge-${process.pid}-${Date.now()}.sock`);
    const runtimeReplica = spawn(
      process.execPath,
      [
        "dist/cli/main.js",
        "runtime",
        "replica",
        "--mode",
        "edge",
        "--edge-id",
        "team-envelope-test",
        "--socket",
        socketPath,
        "--state-dir",
        tmp,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    try {
      await waitForSocket(socketPath, runtimeReplica);
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
          "--runtime-host-socket",
          socketPath,
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
          "--runtime-host-socket",
          socketPath,
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
        "--runtime-host-socket",
        socketPath,
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
      runtimeReplica.kill("SIGTERM");
      if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
      if (existsSync(socketPath)) rmSync(socketPath, { force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Real CLI boundary tests — Skill
// ---------------------------------------------------------------------------
describe("Skill CLI real output envelope", () => {
  it("failure: skill list requires a run-scoped host socket", () => {
    const tmp = mkdtempSync(join(tmpdir(), "skill-env-test-"));
    try {
      const env = { ...process.env };
      delete env.TAH_SKILL_HOST_SOCKET;
      const result = runCli(["skill", "list", "--json", "--state-dir", tmp], { env });
      const output = result.stdout as Record<string, unknown> | null;
      expect(output).not.toBeNull();
      expect(output!.ok).toBe(false);
      expect(output!.tool).toBe("skill");
      expect(output!.version).toBeDefined();
      expect(output!.errorCode).toBe("SKILL_HOST_NOT_FOUND");
    } finally {
      if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("failure: skill show does not fall back to direct store access", () => {
    const env = { ...process.env };
    delete env.TAH_SKILL_HOST_SOCKET;
    const result = runCli(["skill", "show", "nonexistent-skill", "--json"], { env });
    const output = result.stdout as Record<string, unknown> | null;
    expect(output).not.toBeNull();
    expect(output!.ok).toBe(false);
    expect(output!.tool).toBe("skill");
    expect(output!.version).toBeDefined();
    expect(output!.errorCode).toBe("SKILL_HOST_NOT_FOUND");
  });

  it("failure: skill status requires a run-scoped host socket", () => {
    const tmp = mkdtempSync(join(tmpdir(), "skill-env-test-"));
    try {
      const env = { ...process.env };
      delete env.TAH_SKILL_HOST_SOCKET;
      const result = runCli(["skill", "status", "--json", "--state-dir", tmp], { env });
      const output = result.stdout as Record<string, unknown> | null;
      expect(output).not.toBeNull();
      expect(output!.ok).toBe(false);
      expect(output!.tool).toBe("skill");
      expect(output!.version).toBeDefined();
      expect(output!.errorCode).toBe("SKILL_HOST_NOT_FOUND");
    } finally {
      if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Real CLI boundary tests — MCP
// ---------------------------------------------------------------------------
describe("MCP CLI real output envelope", () => {
  it("failure: mcp list requires a run-scoped host socket", () => {
    const tmp = mkdtempSync(join(tmpdir(), "mcp-env-test-"));
    try {
      const env = { ...process.env };
      delete env.TAH_MCP_HOST_SOCKET;
      // --state-dir must come before subcommand per main.ts routing
      const result = runCli(["--state-dir", tmp, "mcp", "list", "--json"], { env });
      const output = result.stdout as Record<string, unknown> | null;
      expect(output).not.toBeNull();
      expect(output!.ok).toBe(false);
      expect(output!.tool).toBe("mcp");
      expect(output!.version).toBeDefined();
      expect(output!.errorCode).toBe("MCP_HOST_NOT_FOUND");
    } finally {
      if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("failure: mcp unknown command does not fall back to local parsing", () => {
    const tmp = mkdtempSync(join(tmpdir(), "mcp-env-test-"));
    try {
      const env = { ...process.env };
      delete env.TAH_MCP_HOST_SOCKET;
      const result = runCli(["--state-dir", tmp, "mcp", "nonexistent-cmd", "--json"], { env });
      const output = result.stdout as Record<string, unknown> | null;
      expect(output).not.toBeNull();
      expect(output!.ok).toBe(false);
      expect(output!.tool).toBe("mcp");
      expect(output!.version).toBeDefined();
      expect(output!.errorCode).toBe("MCP_HOST_NOT_FOUND");
    } finally {
      if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Real CLI boundary tests — Code Intelligence
// ---------------------------------------------------------------------------
describe("Code intelligence CLI real output envelope", () => {
  it("failure: codeq capabilities requires a run-scoped host socket", () => {
    const tmp = mkdtempSync(join(tmpdir(), "codeq-env-test-"));
    try {
      const env = { ...process.env };
      delete env.TAH_CODEQ_HOST_SOCKET;
      const result = spawnSync(
        process.execPath,
        [join(process.cwd(), "dist/cli/main.js"), "codeq", "capabilities", "--json"],
        {
          cwd: tmp,
          env,
          encoding: "utf8",
          timeout: 15_000,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const output = result.stdout && result.stdout.trim()
        ? JSON.parse(result.stdout.trim()) as Record<string, unknown>
        : null;
      expect(result.status).not.toBe(0);
      expect(output).not.toBeNull();
      expect(output!.ok).toBe(false);
      expect(output!.tool).toBe("codeq");
      expect(output!.version).toBeDefined();
      expect(output!.error).toMatchObject({ code: "server_not_found" });
    } finally {
      if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
    }
  });
});
