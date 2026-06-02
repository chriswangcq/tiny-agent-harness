import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runMcpCli } from "../src/mcp/cli.js";

const tmpBase = path.join(os.tmpdir(), "mcp-cli-test-" + process.pid);
const stateDir = path.join(tmpBase, ".tiny-agent");

beforeEach(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
  fs.mkdirSync(stateDir, { recursive: true });
  process.env.TAH_STATE_DIR = stateDir;
});

afterEach(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
  delete process.env.TAH_STATE_DIR;
});

function captureStdout(fn: () => Promise<number>): Promise<{ rc: number; lines: string[] }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: any, encoding?: any, cb?: any) => {
      if (typeof chunk === "string") chunks.push(Buffer.from(chunk));
      else chunks.push(chunk);
      return true;
    };
    fn()
      .then((rc) => {
        process.stdout.write = orig;
        resolve({ rc, lines: Buffer.concat(chunks).toString().split("\n").filter(Boolean) });
      })
      .catch((err) => {
        process.stdout.write = orig;
        reject(err);
      });
  });
}

describe("mcp CLI", () => {
  it("help outputs usage", async () => {
    const { rc, lines } = await captureStdout(() => runMcpCli(["--help"]));
    expect(rc).toBe(0);
    expect(lines.some((l) => l.includes("Usage"))).toBe(true);
  });

  it("add and list --json output has boolean ok", async () => {
    // add with --json
    const { lines: addOut } = await captureStdout(() =>
      runMcpCli(["--json", "add", "test-srv", "echo", "hello"])
    );
    const addJson = JSON.parse(addOut[0]);
    expect(addJson.ok).toBe(true);
    expect(addJson.name).toBe("test-srv");

    // list with --json
    const { lines: listOut } = await captureStdout(() =>
      runMcpCli(["list", "--json"])
    );
    const listJson = JSON.parse(listOut[0]);
    expect(listJson.ok).toBe(true);
    expect(listJson.servers).toBeInstanceOf(Array);
    const srv = listJson.servers.find((s: any) => s.name === "test-srv");
    expect(srv).toBeDefined();
    expect(srv.command).toBe("echo");
    // --json should NOT be in server args
    expect(srv.args).toEqual(["hello"]);
  });

  it("add without --json has --json NOT in server args", async () => {
    const { lines } = await captureStdout(() =>
      runMcpCli(["add", "test2", "node", "-e", "1", "--json"])
    );
    // Read the registry file directly - format is { servers: { test2: { command, args } } }
    const raw = fs.readFileSync(path.join(stateDir, "mcp-servers.json"), "utf-8");
    const data = JSON.parse(raw);
    expect(data.servers).toBeDefined();
    const srv = data.servers["test2"];
    expect(srv).toBeDefined();
    // --json at the end should be output flag, not server arg
    expect(srv.args).toEqual(["-e", "1"]);
  });

  it("add with -- separator stores literal --json as server arg", async () => {
    const { lines } = await captureStdout(() =>
      runMcpCli(["add", "test3", "echo", "--", "--json", "--foo"])
    );
    const raw = fs.readFileSync(path.join(stateDir, "mcp-servers.json"), "utf-8");
    const data = JSON.parse(raw);
    expect(data.servers).toBeDefined();
    const srv = data.servers["test3"];
    expect(srv).toBeDefined();
    expect(srv.args).toEqual(["--json", "--foo"]);
  });

  it("remove --json output ok is boolean", async () => {
    // add first
    await captureStdout(() => runMcpCli(["add", "to-remove", "cmd"]));
    // remove with --json
    const { lines } = await captureStdout(() =>
      runMcpCli(["--json", "remove", "to-remove"])
    );
    const json = JSON.parse(lines[0]);
    expect(json.ok).toBe(true);
    expect(json.name).toBe("to-remove");
  });

  it("remove non-existent returns ok:false", async () => {
    const { lines } = await captureStdout(() =>
      runMcpCli(["--json", "remove", "nope"])
    );
    const json = JSON.parse(lines[0]);
    expect(json.ok).toBe(false);
  });

  it("unknown command dies", async () => {
    // die() calls process.exit(1), which vitest catches as an error
    let didThrow = false;
    try {
      await runMcpCli(["nope"]);
    } catch {
      didThrow = true;
    }
    expect(didThrow).toBe(true);
  });
});
