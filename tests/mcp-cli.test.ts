import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runMcpCli, type McpCliDeps } from "../src/mcp/cli.js";

const tmpBase = path.join(os.tmpdir(), "mcp-cli-test-" + process.pid);
const stateDir = path.join(tmpBase, ".tiny-agent");

function makeDeps(options?: {
  env?: Record<string, string | undefined>;
  cwd?: string;
}): {
  deps: McpCliDeps;
  stdoutLines: () => string[];
  stderrLines: () => string[];
} {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const deps: McpCliDeps = {
    stdout: {
      write(text: string) {
        outChunks.push(text);
        return undefined;
      },
    },
    stderr: {
      write(text: string) {
        errChunks.push(text);
        return undefined;
      },
    },
    env: options?.env ?? {},
    cwd: options?.cwd ?? process.cwd(),
  };
  const lines = (chunks: string[]) =>
    Buffer.concat(chunks.map((c) => Buffer.from(c)))
      .toString()
      .split("\n")
      .filter(Boolean);
  return {
    deps,
    stdoutLines: () => lines(outChunks),
    stderrLines: () => lines(errChunks),
  };
}

function makeTestDeps() {
  return makeDeps({ env: { TAH_STATE_DIR: stateDir } });
}

beforeEach(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
  fs.mkdirSync(stateDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

describe("mcp CLI", () => {
  it("help returns rc=0 and prints usage", async () => {
    const h = makeTestDeps();
    const rc = await runMcpCli(["--help"], h.deps);
    expect(rc).toBe(0);
    expect(h.stdoutLines().some((l) => l.includes("Usage"))).toBe(true);
  });

  it("help with no command returns rc=0 and prints usage", async () => {
    const h = makeTestDeps();
    const rc = await runMcpCli([], h.deps);
    expect(rc).toBe(0);
    expect(h.stdoutLines().some((l) => l.includes("Usage"))).toBe(true);
  });

  it("add and list --json output has boolean ok", async () => {
    // add with --json
    const addRun = makeTestDeps();
    const addRc = await runMcpCli(
      ["--json", "add", "test-srv", "echo", "hello"],
      addRun.deps,
    );
    expect(addRc).toBe(0);
    const addJson = JSON.parse(addRun.stdoutLines()[0]);
    expect(addJson.ok).toBe(true);
    expect(addJson.name).toBe("test-srv");

    // list with --json
    const listRun = makeTestDeps();
    const listRc = await runMcpCli(["list", "--json"], listRun.deps);
    expect(listRc).toBe(0);
    const listJson = JSON.parse(listRun.stdoutLines()[0]);
    expect(listJson.ok).toBe(true);
    expect(listJson.servers).toBeInstanceOf(Array);
    const srv = listJson.servers.find((s: any) => s.name === "test-srv");
    expect(srv).toBeDefined();
    expect(srv.command).toBe("echo");
    expect(srv.args).toEqual(["hello"]);
  });

  it("add without --json has --json NOT in server args", async () => {
    const h = makeTestDeps();
    const rc = await runMcpCli(
      ["add", "test2", "node", "-e", "1", "--json"],
      h.deps,
    );
    expect(rc).toBe(0);

    const raw = fs.readFileSync(
      path.join(stateDir, "mcp-servers.json"),
      "utf-8",
    );
    const data = JSON.parse(raw);
    expect(data.servers).toBeDefined();
    const srv = data.servers["test2"];
    expect(srv).toBeDefined();
    expect(srv.args).toEqual(["-e", "1"]);
  });

  it("add with -- separator stores literal --json as server arg", async () => {
    const h = makeTestDeps();
    const rc = await runMcpCli(
      ["add", "test3", "echo", "--", "--json", "--foo"],
      h.deps,
    );
    expect(rc).toBe(0);

    const raw = fs.readFileSync(
      path.join(stateDir, "mcp-servers.json"),
      "utf-8",
    );
    const data = JSON.parse(raw);
    expect(data.servers).toBeDefined();
    const srv = data.servers["test3"];
    expect(srv).toBeDefined();
    expect(srv.args).toEqual(["--json", "--foo"]);
  });

  it("keeps trailing --json literal after -- separator", async () => {
    const h = makeTestDeps();
    const rc = await runMcpCli(
      ["add", "test-json-tail", "echo", "--", "--foo", "--json"],
      h.deps,
    );
    expect(rc).toBe(0);

    const raw = fs.readFileSync(
      path.join(stateDir, "mcp-servers.json"),
      "utf-8",
    );
    const data = JSON.parse(raw);
    const srv = data.servers["test-json-tail"];
    expect(srv).toBeDefined();
    expect(srv.args).toEqual(["--foo", "--json"]);
  });

  it("remove --json output ok is boolean", async () => {
    // add first
    const addRun = makeTestDeps();
    await runMcpCli(["add", "to-remove", "cmd"], addRun.deps);

    // remove with --json
    const removeRun = makeTestDeps();
    const rc = await runMcpCli(
      ["--json", "remove", "to-remove"],
      removeRun.deps,
    );
    expect(rc).toBe(0);
    const json = JSON.parse(removeRun.stdoutLines()[0]);
    expect(json.ok).toBe(true);
    expect(json.name).toBe("to-remove");
  });

  it("remove non-existent returns ok:false", async () => {
    const h = makeTestDeps();
    const rc = await runMcpCli(["--json", "remove", "nope"], h.deps);
    expect(rc).toBe(0);
    const json = JSON.parse(h.stdoutLines()[0]);
    expect(json.ok).toBe(false);
  });

  it("unknown command returns rc=1 with JSON error on stderr", async () => {
    const h = makeTestDeps();
    const rc = await runMcpCli(["nope"], h.deps);
    expect(rc).toBe(1);
    const errLines = h.stderrLines();
    expect(errLines.length).toBeGreaterThanOrEqual(1);
    const err = JSON.parse(errLines[0]);
    expect(err.ok).toBe(false);
    expect(err.error).toContain("Unknown command");
  });

  it("add missing args returns rc=1 with JSON error", async () => {
    const h = makeTestDeps();
    const rc = await runMcpCli(["add", "only-name"], h.deps);
    expect(rc).toBe(1);
    const err = JSON.parse(h.stderrLines()[0]);
    expect(err.ok).toBe(false);
    expect(err.error).toContain("Usage");
  });

  it("remove missing name returns rc=1 with JSON error", async () => {
    const h = makeTestDeps();
    const rc = await runMcpCli(["remove"], h.deps);
    expect(rc).toBe(1);
    const err = JSON.parse(h.stderrLines()[0]);
    expect(err.ok).toBe(false);
    expect(err.error).toContain("Usage");
  });

  it("tools missing server name returns rc=1", async () => {
    const h = makeTestDeps();
    const rc = await runMcpCli(["tools"], h.deps);
    expect(rc).toBe(1);
    const err = JSON.parse(h.stderrLines()[0]);
    expect(err.ok).toBe(false);
    expect(err.error).toContain("Usage");
  });

  it("tools non-existent server returns rc=1", async () => {
    const h = makeTestDeps();
    const rc = await runMcpCli(["tools", "nope"], h.deps);
    expect(rc).toBe(1);
    const err = JSON.parse(h.stderrLines()[0]);
    expect(err.ok).toBe(false);
    expect(err.error).toContain("not found");
  });

  it("call missing args returns rc=1", async () => {
    const h = makeTestDeps();
    const rc = await runMcpCli(["call", "srv"], h.deps);
    expect(rc).toBe(1);
    const err = JSON.parse(h.stderrLines()[0]);
    expect(err.ok).toBe(false);
    expect(err.error).toContain("Usage");
  });

  it("call non-existent server returns rc=1", async () => {
    const h = makeTestDeps();
    const rc = await runMcpCli(["call", "nope", "tool"], h.deps);
    expect(rc).toBe(1);
    const err = JSON.parse(h.stderrLines()[0]);
    expect(err.ok).toBe(false);
    expect(err.error).toContain("not found");
  });

  it("call --args-json invalid JSON returns rc=1", async () => {
    const h = makeTestDeps();
    // Add a server first
    await runMcpCli(["add", "s1", "echo"], h.deps);
    const rc = await runMcpCli(
      ["call", "s1", "t", "--args-json", "not-json"],
      h.deps,
    );
    expect(rc).toBe(1);
    const err = JSON.parse(h.stderrLines()[0]);
    expect(err.ok).toBe(false);
    expect(err.error).toContain("Invalid JSON");
  });

  it("uses cwd-based state dir when env is not set", async () => {
    // No TAH_STATE_DIR in env, falls back to deps.cwd/.tiny-agent
    const altTmp = path.join(os.tmpdir(), "mcp-cli-test-cwd-" + process.pid);
    const altState = path.join(altTmp, ".tiny-agent");
    fs.rmSync(altTmp, { recursive: true, force: true });
    fs.mkdirSync(altState, { recursive: true });
    try {
      const h = makeDeps({ cwd: altTmp, env: {} });
      const rc = await runMcpCli(
        ["--json", "add", "cwd-srv", "echo"],
        h.deps,
      );
      expect(rc).toBe(0);
      const json = JSON.parse(h.stdoutLines()[0]);
      expect(json.ok).toBe(true);

      // Verify it wrote to cwd-based path
      const raw = fs.readFileSync(
        path.join(altState, "mcp-servers.json"),
        "utf-8",
      );
      const data = JSON.parse(raw);
      expect(data.servers["cwd-srv"]).toBeDefined();
    } finally {
      fs.rmSync(altTmp, { recursive: true, force: true });
    }
  });
});
