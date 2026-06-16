import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { runIm, type ImCliDeps } from "../src/cli/im.js";
import {
  type RuntimeImRequest,
  type RuntimeImResponse,
} from "../src/im/index.js";

type HostClientRequest = Parameters<ImCliDeps["requestHost"]>[0];

describe("runIm public IM CLI", () => {
  let tmpDirs: string[] = [];

  function createStateDir(prefix = "im-cli-test-"): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
  }

  function makeHostResult(
    request: RuntimeImRequest,
    data: Record<string, unknown>,
  ): RuntimeImResponse {
    return {
      schemaVersion: 1,
      id: request.id,
      ok: true,
      type: "im.result",
      command: request.type,
      data,
    };
  }

  async function runCaptured(
    args: string[],
    options: {
      env?: Record<string, string | undefined>;
      stdin?: Readable;
      requestHost?: ImCliDeps["requestHost"];
      newRequestId?: () => string;
    } = {},
  ): Promise<{
    code: number;
    stdout: string;
    stderr: string;
    stdoutJson: Record<string, any> | null;
    stderrJson: Record<string, any> | null;
  }> {
    let stdout = "";
    let stderr = "";
    const code = await runIm(args, {
      env: options.env ?? {},
      stdin: options.stdin ?? Readable.from([]),
      stdout: {
        write: (text: string) => {
          stdout += text;
          return true;
        },
      },
      stderr: {
        write: (text: string) => {
          stderr += text;
          return true;
        },
      },
      timeoutMs: 1234,
      newRequestId: options.newRequestId ?? (() => "im-cli-test-request"),
      requestHost:
        options.requestHost ??
        (async (call) =>
          makeHostResult(call.request, {
            ok: true,
          })),
      sleep: async () => undefined,
    });

    return {
      code,
      stdout,
      stderr,
      stdoutJson: parseJsonLine(stdout),
      stderrJson: parseJsonLine(stderr),
    };
  }

  function parseJsonLine(text: string): Record<string, any> | null {
    const trimmed = text.trim();
    return trimmed.startsWith("{") ? (JSON.parse(trimmed) as Record<string, any>) : null;
  }

  afterEach(() => {
    for (const dir of tmpDirs) {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
    tmpDirs = [];
  });

  const runImEnv = {
    TAH_RUNTIME_HOST_SOCKET: "/tmp/project/runtime.sock",
    TAH_IM_RUN_ID: "run-1",
    TAH_IM_SELF_ENDPOINT: "run:run-1",
    TAH_IM_USER_ENDPOINT: "user:main",
  };

  it("ordinary post sends a typed request to the runtime replica", async () => {
    const calls: HostClientRequest[] = [];
    const result = await runCaptured(
      [
        "post",
        "--from",
        "user:main",
        "--to",
        "member:team-p6/coder-1",
        "--text",
        "first",
        "--json",
      ],
      {
        env: runImEnv,
        requestHost: async (call) => {
          calls.push(call);
          return makeHostResult(call.request, {
            message: {
              id: "msg-1",
              text: "first",
              from: "user:main",
              to: "member:team-p6/coder-1",
            },
            id: "msg-1",
            from: "user:main",
            to: "member:team-p6/coder-1",
          });
        },
      },
    );

    expect(result.code).toBe(0);
    expect(result.stdoutJson).toMatchObject({
      ok: true,
      tool: "im",
      id: "msg-1",
      from: "user:main",
      to: "member:team-p6/coder-1",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.socketPath).toBe("/tmp/project/runtime.sock");
    expect(calls[0]!.timeoutMs).toBe(1234);
    expect(calls[0]!.request).toMatchObject({
      schemaVersion: 1,
      id: "im-cli-test-request",
      type: "im.post",
      from: "user:main",
      to: "member:team-p6/coder-1",
      text: "first",
      metadata: { source: "cli" },
    });
  });

  it("ordinary send reads text-stdin and writes explicit run endpoints from env", async () => {
    const calls: HostClientRequest[] = [];
    const result = await runCaptured(
      ["send", "--kind", "status", "--text-stdin", "--json"],
      {
        env: runImEnv,
        stdin: Readable.from(["## report\n\n- done\n"]),
        newRequestId: () => "send-1",
        requestHost: async (call) => {
          calls.push(call);
          return makeHostResult(call.request, {
            id: "msg-status",
            from: "run:run-1",
            to: "user:main",
            kind: "status",
            message: { id: "msg-status", text: "## report\n\n- done\n" },
          });
        },
      },
    );

    expect(result.code).toBe(0);
    expect(result.stdoutJson).toMatchObject({
      ok: true,
      kind: "status",
      id: "msg-status",
    });
    expect(calls[0]!.request).toMatchObject({
      id: "send-1",
	      type: "im.send",
	      from: "run:run-1",
	      to: "user:main",
	      kind: "status",
	      text: "## report\n\n- done\n",
	    });
	  });

  it("ordinary recv and ack use host requests and preserve envelope output", async () => {
    const calls: HostClientRequest[] = [];
    const responses = [
      {
        count: 1,
        nextCursor: "msg-1",
        messages: [{ id: "msg-1", text: "hello" }],
      },
      {
        as: "run:run-1",
        with: "user:main",
        messageId: "msg-1",
      },
    ];

    const recv = await runCaptured(
      ["recv", "--as", "run:run-1", "--with", "user:main", "--cursor", "msg-0", "--json"],
      {
        env: runImEnv,
        requestHost: async (call) => {
          calls.push(call);
          return makeHostResult(call.request, responses.shift()!);
        },
      },
    );
    const ack = await runCaptured(
      ["ack", "--as", "run:run-1", "--with", "user:main", "--message-id", "msg-1", "--json"],
      {
        env: runImEnv,
        requestHost: async (call) => {
          calls.push(call);
          return makeHostResult(call.request, responses.shift()!);
        },
      },
    );

    expect(recv.code).toBe(0);
    expect(ack.code).toBe(0);
    expect(recv.stdoutJson).toMatchObject({ ok: true, count: 1, nextCursor: "msg-1" });
    expect(ack.stdoutJson).toMatchObject({ ok: true, messageId: "msg-1" });
    expect(calls.map((call) => call.request.type)).toEqual(["im.recv", "im.ack"]);
    expect(calls[0]!.request).toMatchObject({
      as: "run:run-1",
      with: "user:main",
      cursor: "msg-0",
    });
  });

  it("ordinary recv and ack fill explicit endpoints from run env", async () => {
    const calls: HostClientRequest[] = [];

    const recv = await runCaptured(["recv", "--json"], {
      env: runImEnv,
      requestHost: async (call) => {
        calls.push(call);
        return makeHostResult(call.request, {
          as: "run:run-1",
          with: "user:main",
          count: 1,
          messages: [{ id: "msg-1", text: "from default pair" }],
        });
      },
    });
    const ack = await runCaptured(["ack", "--message-id", "msg-1", "--json"], {
      env: runImEnv,
      requestHost: async (call) => {
        calls.push(call);
        return makeHostResult(call.request, {
          as: "run:run-1",
          with: "user:main",
          messageId: "msg-1",
        });
      },
    });

    expect(recv.code).toBe(0);
    expect(ack.code).toBe(0);
    expect(recv.stdoutJson).toMatchObject({ ok: true, count: 1 });
    expect(ack.stdoutJson).toMatchObject({ ok: true, messageId: "msg-1" });
    expect(calls.map((call) => call.request.type)).toEqual(["im.recv", "im.ack"]);
    expect(calls[0]!.request).toMatchObject({
      as: "run:run-1",
      with: "user:main",
    });
    expect(calls[1]!.request).toMatchObject({
      type: "im.ack",
      as: "run:run-1",
      with: "user:main",
      messageId: "msg-1",
    });
  });

  it("ordinary run-recv and run-ack fill explicit run context from env", async () => {
    const calls: HostClientRequest[] = [];

    await runCaptured(["run-recv", "--json"], {
      env: runImEnv,
      requestHost: async (call) => {
        calls.push(call);
        return makeHostResult(call.request, {
          runId: "run-1",
          self: "run:run-1",
          count: 0,
          messages: [],
          nextCursors: {},
        });
      },
    });
    await runCaptured(["run-ack", "--message-id", "msg-1", "--json"], {
      env: runImEnv,
      requestHost: async (call) => {
        calls.push(call);
        return makeHostResult(call.request, {
          runId: "run-1",
          peer: "user:main",
          messageId: "msg-1",
        });
      },
    });

    expect(calls.map((call) => call.request.type)).toEqual([
      "im.run-recv",
      "im.run-ack",
    ]);
    expect(calls[0]!.request).toMatchObject({
      type: "im.run-recv",
      runId: "run-1",
    });
    expect(calls[1]!.request).toMatchObject({
      type: "im.run-ack",
      runId: "run-1",
      peer: "user:main",
      messageId: "msg-1",
    });
  });

  it("ordinary text output is rendered from host result data", async () => {
    const result = await runCaptured(["post", "--text", "hello text"], {
      env: runImEnv,
      requestHost: async (call) =>
        makeHostResult(call.request, {
          message: { text: "hello text" },
          from: "user:main",
          to: "run:run-1",
        }),
    });

    expect(result.code).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "message.text=hello text",
      "from=user:main",
      "to=run:run-1",
    ]);
  });

  it("ordinary commands fail without a runtime replica socket", async () => {
    const result = await runCaptured(["post", "--text", "hello", "--json"]);

    expect(result.code).toBe(1);
    expect(result.stderrJson).toMatchObject({
      ok: false,
      tool: "im",
      errorCode: "RUNTIME_HOST_NOT_FOUND",
    });
  });

  it("ordinary commands reject --state-dir instead of falling back to files", async () => {
    const stateDir = createStateDir();
    const result = await runCaptured([
      "post",
      "--text",
      "hello",
      "--state-dir",
      stateDir,
      "--json",
    ]);

    expect(result.code).toBe(1);
    expect(result.stderrJson).toMatchObject({
      ok: false,
      errorCode: "IM_STATE_DIR_NOT_ALLOWED",
    });
    expect(fs.existsSync(path.join(stateDir, "im"))).toBe(false);
  });

  it("rejects removed admin commands without creating IM files", async () => {
    const stateDir = createStateDir();
    const result = await runCaptured([
      "admin",
      "post",
      "--from",
      "user:main",
      "--to",
      "member:team-p6/coder-1",
      "--text",
      "hello",
      "--state-dir",
      stateDir,
      "--json",
    ]);

    expect(result.code).toBe(1);
    expect(result.stderrJson).toMatchObject({
      ok: false,
      tool: "im",
      errorCode: "IM_ERROR",
    });
    expect(String(result.stderrJson!.error)).toContain("Usage: tiny-agent im");
    expect(fs.existsSync(path.join(stateDir, "im"))).toBe(false);
  });
});
