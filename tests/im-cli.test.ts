import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { runIm, type ImCliDeps } from "../src/cli/im.js";
import {
  planImRunBindingLayout,
  type ImHostRequest,
  type ImHostResponse,
  type PublicImRunReceiveMessage,
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
    request: ImHostRequest,
    data: Record<string, unknown>,
  ): ImHostResponse {
    return {
      schemaVersion: 1,
      id: request.id,
      ok: true,
      type: "im.result",
      command: request.type as Exclude<ImHostRequest["type"], "im.shutdown">,
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

  it("ordinary post sends a typed request to the run-scoped IM host", async () => {
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
        env: { TAH_IM_HOST_SOCKET: "/tmp/run/im-host.sock" },
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
    expect(calls[0]!.socketPath).toBe("/tmp/run/im-host.sock");
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

  it("ordinary send reads text-stdin and allows host defaults for endpoints", async () => {
    const calls: HostClientRequest[] = [];
    const result = await runCaptured(
      ["send", "--kind", "status", "--text-stdin", "--json"],
      {
        env: { TAH_IM_HOST_SOCKET: "/tmp/run/im-host.sock" },
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
      kind: "status",
      text: "## report\n\n- done\n",
    });
    expect((calls[0]!.request as Record<string, unknown>).from).toBeUndefined();
    expect((calls[0]!.request as Record<string, unknown>).to).toBeUndefined();
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
        env: { TAH_IM_HOST_SOCKET: "/tmp/run/im-host.sock" },
        requestHost: async (call) => {
          calls.push(call);
          return makeHostResult(call.request, responses.shift()!);
        },
      },
    );
    const ack = await runCaptured(
      ["ack", "--as", "run:run-1", "--with", "user:main", "--message-id", "msg-1", "--json"],
      {
        env: { TAH_IM_HOST_SOCKET: "/tmp/run/im-host.sock" },
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

  it("ordinary recv and ack can omit endpoints for IM host defaults", async () => {
    const calls: HostClientRequest[] = [];

    const recv = await runCaptured(["recv", "--json"], {
      env: { TAH_IM_HOST_SOCKET: "/tmp/run/im-host.sock" },
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
      env: { TAH_IM_HOST_SOCKET: "/tmp/run/im-host.sock" },
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
    expect((calls[0]!.request as Record<string, unknown>).as).toBeUndefined();
    expect((calls[0]!.request as Record<string, unknown>).with).toBeUndefined();
    expect((calls[1]!.request as Record<string, unknown>).as).toBeUndefined();
    expect((calls[1]!.request as Record<string, unknown>).with).toBeUndefined();
    expect(calls[1]!.request).toMatchObject({
      type: "im.ack",
      messageId: "msg-1",
    });
  });

  it("ordinary run-recv and run-ack allow host default run context", async () => {
    const calls: HostClientRequest[] = [];

    await runCaptured(["run-recv", "--json"], {
      env: { TAH_IM_HOST_SOCKET: "/tmp/run/im-host.sock" },
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
      env: { TAH_IM_HOST_SOCKET: "/tmp/run/im-host.sock" },
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
    expect((calls[0]!.request as Record<string, unknown>).runId).toBeUndefined();
    expect(calls[1]!.request).toMatchObject({
      type: "im.run-ack",
      messageId: "msg-1",
    });
    expect((calls[1]!.request as Record<string, unknown>).peer).toBeUndefined();
  });

  it("ordinary text output is rendered from host result data", async () => {
    const result = await runCaptured(["post", "--text", "hello text"], {
      env: { TAH_IM_HOST_SOCKET: "/tmp/run/im-host.sock" },
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

  it("ordinary commands fail without an IM host socket", async () => {
    const result = await runCaptured(["post", "--text", "hello", "--json"]);

    expect(result.code).toBe(1);
    expect(result.stderrJson).toMatchObject({
      ok: false,
      tool: "im",
      errorCode: "IM_HOST_NOT_FOUND",
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

  it("admin direct-file post + recv + ack keep endpoint-pair cursor semantics", async () => {
    const stateDir = createStateDir();

    const first = await runCaptured([
      "admin",
      "post",
      "--from",
      "user:main",
      "--to",
      "member:team-p6/coder-1",
      "--text",
      "first",
      "--state-dir",
      stateDir,
      "--json",
    ]);
    await runCaptured([
      "admin",
      "post",
      "--from",
      "user:main",
      "--to",
      "member:team-p6/coder-1",
      "--text",
      "second",
      "--state-dir",
      stateDir,
      "--json",
    ]);

    const initial = await runCaptured([
      "admin",
      "recv",
      "--as",
      "member:team-p6/coder-1",
      "--with",
      "user:main",
      "--state-dir",
      stateDir,
      "--json",
    ]);
    expect(initial.stdoutJson!.count).toBe(2);
    expect(initial.stdoutJson!.messages.map((message: { text: string }) => message.text)).toEqual([
      "first",
      "second",
    ]);

    await runCaptured([
      "admin",
      "ack",
      "--as",
      "member:team-p6/coder-1",
      "--with",
      "user:main",
      "--message-id",
      first.stdoutJson!.id,
      "--state-dir",
      stateDir,
      "--json",
    ]);

    const afterAck = await runCaptured([
      "admin",
      "recv",
      "--as",
      "member:team-p6/coder-1",
      "--with",
      "user:main",
      "--state-dir",
      stateDir,
      "--json",
    ]);
    expect(afterAck.stdoutJson!.count).toBe(1);
    expect(afterAck.stdoutJson!.messages[0].text).toBe("second");
  });

  it("admin direct-file send reads stdin and stores agent status messages", async () => {
    const stateDir = createStateDir();
    const sent = await runCaptured(
      [
        "admin",
        "send",
        "--from",
        "member:team-p6/coder-1",
        "--to",
        "user:main",
        "--kind",
        "status",
        "--text-stdin",
        "--state-dir",
        stateDir,
        "--json",
      ],
      { stdin: Readable.from(["## report\n\n- done\n"]) },
    );

    const received = await runCaptured([
      "admin",
      "recv",
      "--as",
      "user:main",
      "--with",
      "member:team-p6/coder-1",
      "--state-dir",
      stateDir,
      "--json",
    ]);

    expect(sent.stdoutJson).toMatchObject({
      ok: true,
      kind: "status",
      from: "member:team-p6/coder-1",
      to: "user:main",
    });
    expect(received.stdoutJson!.messages[0]).toMatchObject({
      id: sent.stdoutJson!.id,
      role: "agent",
      kind: "status",
      text: "## report\n\n- done\n",
    });
  });

  it("admin direct-file run binding aggregates inbound messages and acks by peer", async () => {
    const stateDir = createStateDir();

    await runCaptured([
      "admin",
      "bind",
      "--run-id",
      "run-123",
      "--self",
      "member:team-p6/coder-1",
      "--peer",
      "user:main",
      "--kind",
      "a2user",
      "--state-dir",
      stateDir,
      "--json",
    ]);
    await runCaptured([
      "admin",
      "bind",
      "--run-id",
      "run-123",
      "--self",
      "member:team-p6/coder-1",
      "--peer",
      "member:team-p6/reviewer-1",
      "--kind",
      "a2a",
      "--state-dir",
      stateDir,
      "--json",
    ]);
    const userMessage = await runCaptured([
      "admin",
      "post",
      "--from",
      "user:main",
      "--to",
      "member:team-p6/coder-1",
      "--text",
      "from user",
      "--state-dir",
      stateDir,
      "--json",
    ]);
    const reviewerMessage = await runCaptured([
      "admin",
      "send",
      "--from",
      "member:team-p6/reviewer-1",
      "--to",
      "member:team-p6/coder-1",
      "--kind",
      "status",
      "--text",
      "from reviewer",
      "--state-dir",
      stateDir,
      "--json",
    ]);

    const received = await runCaptured([
      "admin",
      "run-recv",
      "--run-id",
      "run-123",
      "--state-dir",
      stateDir,
      "--json",
    ]);
    expect(received.stdoutJson!.count).toBe(2);
    expect(
      received.stdoutJson!.messages.map((message: PublicImRunReceiveMessage) => message.text),
    ).toEqual(["from user", "from reviewer"]);
    expect(
      received.stdoutJson!.messages.map((message: PublicImRunReceiveMessage) => message.binding.kind),
    ).toEqual(["a2user", "a2a"]);

    await runCaptured([
      "admin",
      "run-ack",
      "--run-id",
      "run-123",
      "--peer",
      "user:main",
      "--message-id",
      userMessage.stdoutJson!.id,
      "--state-dir",
      stateDir,
      "--json",
    ]);

    const afterAck = await runCaptured([
      "admin",
      "run-recv",
      "--run-id",
      "run-123",
      "--state-dir",
      stateDir,
      "--json",
    ]);
    expect(afterAck.stdoutJson!.messages.map((message: { id: string }) => message.id)).toEqual([
      reviewerMessage.stdoutJson!.id,
    ]);

    const bindingLayout = planImRunBindingLayout(stateDir, "run-123");
    expect(fs.existsSync(bindingLayout.bindingFile)).toBe(true);
  });

  it("admin uses TAH_STATE_DIR as the default public IM root", async () => {
    const stateDir = createStateDir();

    await runCaptured(
      [
        "admin",
        "post",
        "--from",
        "user:main",
        "--to",
        "member:team-p6/coder-1",
        "--text",
        "hello env root",
        "--json",
      ],
      { env: { TAH_STATE_DIR: stateDir } },
    );

    const received = await runCaptured(
      [
        "admin",
        "recv",
        "--as",
        "member:team-p6/coder-1",
        "--with",
        "user:main",
        "--json",
      ],
      { env: { TAH_STATE_DIR: stateDir } },
    );
    expect(received.stdoutJson!.messages[0].text).toBe("hello env root");
  });

  it("admin prefers TAH_IM_STATE_DIR over TAH_STATE_DIR for public IM storage", async () => {
    const publicStateDir = createStateDir();
    const runLocalStateDir = createStateDir("im-cli-run-local-");

    await runCaptured(
      [
        "admin",
        "post",
        "--from",
        "user:main",
        "--to",
        "member:team-p6/coder-1",
        "--text",
        "hello explicit im root",
        "--json",
      ],
      {
        env: {
          TAH_STATE_DIR: runLocalStateDir,
          TAH_IM_STATE_DIR: publicStateDir,
        },
      },
    );

    const received = await runCaptured(
      [
        "admin",
        "recv",
        "--as",
        "member:team-p6/coder-1",
        "--with",
        "user:main",
        "--json",
      ],
      {
        env: {
          TAH_STATE_DIR: runLocalStateDir,
          TAH_IM_STATE_DIR: publicStateDir,
        },
      },
    );
    expect(received.stdoutJson!.messages[0].text).toBe("hello explicit im root");
    expect(fs.existsSync(path.join(publicStateDir, "im"))).toBe(true);
    expect(fs.existsSync(path.join(runLocalStateDir, "im"))).toBe(false);
  });

  it("admin malformed endpoints return a failure envelope without process.exit monkeypatching", async () => {
    const stateDir = createStateDir();
    const result = await runCaptured([
      "admin",
      "post",
      "--from",
      "not-an-endpoint",
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
    expect(result.stderrJson!.error).toMatch(/Invalid IM endpoint/);
  });
});
