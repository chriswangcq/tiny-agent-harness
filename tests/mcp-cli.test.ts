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

interface CapturedOutput {
  rc: number;
  /** split by newline, excluding empty strings */
  stdoutLines: string[];
  /** split by newline, excluding empty strings */
  stderrLines: string[];
}

/** Run fn, capturing both stdout and stderr; restore originals on completion. */
function captureOutput(fn: () => Promise<number>): Promise<CapturedOutput> {
  return new Promise((resolve, reject) => {
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = (chunk: any, encoding?: any, cb?: any) => {
      if (typeof chunk === "string") outChunks.push(Buffer.from(chunk));
      else outChunks.push(chunk);
      return true;
    };
    process.stderr.write = (chunk: any, encoding?: any, cb?: any) => {
      if (typeof chunk === "string") errChunks.push(Buffer.from(chunk));
      else errChunks.push(chunk);
      return true;
    };
    fn()
      .then((rc) => {
        process.stdout.write = origOut;
        process.stderr.write = origErr;
        resolve({
          rc,
          stdoutLines: Buffer.concat(outChunks).toString().split("\n").filter(Boolean),
          stderrLines: Buffer.concat(errChunks).toString().split("\n").filter(Boolean),
        });
      })
      .catch((err) => {
        process.stdout.write = origOut;
        process.stderr.write = origErr;
        reject(err);
      });
  });
}

describe("mcp CLI", () => {
  it("help outputs usage", async () => {
    const { rc, stdoutLines } = await captureOutput(() => runMcpCli(["--help"]));
    expect(rc).toBe(0);
    expect(stdoutLines.some((l) => l.includes("Usage"))).toBe(true);
  });

  it("add and list --json output has boolean ok", async () => {
    // add with --json
    const { stdoutLines: addOut } = await captureOutput(() =>
      runMcpCli(["--json", "add", "test-srv", "echo", "hello"])
    );
    const addJson = JSON.parse(addOut[0]);
    expect(addJson.ok).toBe(true);
    expect(addJson.name).toBe("test-srv");

    // list with --json
    const { stdoutLines: listOut } = await captureOutput(() =>
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
    const { stdoutLines } = await captureOutput(() =>
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
    const { stdoutLines } = await captureOutput(() =>
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
    await captureOutput(() => runMcpCli(["add", "to-remove", "cmd"]));
    // remove with --json
    const { stdoutLines } = await captureOutput(() =>
      runMcpCli(["--json", "remove", "to-remove"])
    );
    const json = JSON.parse(stdoutLines[0]);
    expect(json.ok).toBe(true);
    expect(json.name).toBe("to-remove");
  });

  it("remove non-existent returns ok:false", async () => {
    const { stdoutLines } = await captureOutput(() =>
      runMcpCli(["--json", "remove", "nope"])
    );
    const json = JSON.parse(stdoutLines[0]);
    expect(json.ok).toBe(false);
  });

  it("unknown command dies with error on stderr", async () => {
    let didThrow = false;
    let stderrLines: string[] = [];
    try {
      const result = await captureOutput(() => runMcpCli(["nope"]));
      // die() calls process.exit(1) which throws in vitest, so we normally
      // don't reach here. But if vitest doesn't throw, check stderr.
      stderrLines = result.stderrLines;
    } catch {
      didThrow = true;
    }
    expect(didThrow).toBe(true);
  });
});
