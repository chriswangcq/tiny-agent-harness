import { describe, expect, it } from "vitest";
import { TerminalService } from "../src/application/terminal-service.js";
import type {
  TerminalRuntimeSnapshot,
  TerminalServiceConfig,
  TerminalServicePorts,
} from "../src/application/terminal-ports.js";
import type { TerminalOwner } from "../src/terminal/index.js";

function shell(revision = 1): TerminalOwner {
  return {
    kind: "shell",
    revision,
    cwd: "/repo",
    promptSeq: 1,
    lastReturnCode: 0,
    promptNonce: "nonce",
  };
}

function makeSnapshot(owner: TerminalOwner = shell()): TerminalRuntimeSnapshot {
  return {
    session: "default",
    owner,
    parserState: { pending: "", totalBytes: 0 },
  };
}

function makeConfig(): TerminalServiceConfig {
  return {
    defaultSessionId: "default",
    promptNonce: "nonce",
    actionLimits: {
      maxWriteTextBytes: 4096,
      maxFrameBytes: 4096,
    },
    observationLimits: {
      maxPreviewChars: 80,
    },
  };
}

function makePorts(options: {
  snapshot?: TerminalRuntimeSnapshot | null;
  readChunk?: string;
} = {}): {
  ports: TerminalServicePorts;
  writes: string[];
  saves: TerminalRuntimeSnapshot[];
  logs: unknown[];
} {
  const writes: string[] = [];
  const saves: TerminalRuntimeSnapshot[] = [];
  const logs: unknown[] = [];

  return {
    writes,
    saves,
    logs,
    ports: {
      clock: {
        nowIso: () => "2026-05-27T00:00:00.000Z",
        monotonicMs: () => 1,
      },
      ids: {
        newId: (prefix) => `${prefix}-1`,
        newNonce: () => "nonce",
      },
      pty: {
        write: async (_session, data) => {
          writes.push(data);
        },
        read: async () => ({
          chunk: options.readChunk ?? "",
          logRef: { kind: "log", ref: "log-1" },
        }),
        interrupt: async () => {},
        terminate: async () => {},
        restart: async () => makeSnapshot(shell(0)),
      },
      sessions: {
        load: async () => options.snapshot ?? makeSnapshot(),
        save: async (snapshot) => {
          saves.push(snapshot);
        },
      },
      logger: {
        event: (event) => {
          logs.push(event);
        },
      },
    },
  };
}

describe("TerminalService", () => {
  it("rejects stale owner actions without writing or saving", async () => {
    const { ports, writes, saves } = makePorts({ snapshot: makeSnapshot(shell(2)) });
    const service = new TerminalService(ports, makeConfig());

    const observation = await service.handleAction({
      kind: "write_text",
      expectedOwnerRevision: 1,
      text: "echo stale",
    });

    expect(observation).toMatchObject({
      result: "rejected",
      errorCode: "OWNER_MISMATCH",
    });
    expect(writes).toEqual([]);
    expect(saves).toEqual([]);
  });

  it("writes shell input, parses prompt output, saves snapshot, and returns compact observation", async () => {
    const { ports, writes, saves } = makePorts({
      snapshot: makeSnapshot(shell(1)),
      readChunk: "__TAH_PROMPT__ nonce=nonce rc=0 cwd=%2Frepo%2Fnext seq=2\n",
    });
    const service = new TerminalService(ports, makeConfig());

    const observation = await service.handleAction({
      kind: "write_text",
      expectedOwnerRevision: 1,
      text: "echo ok\n",
    });

    expect(writes).toEqual(["echo ok\n"]);
    expect(saves).toHaveLength(1);
    expect(saves[0]?.owner).toMatchObject({
      kind: "shell",
      revision: 2,
      cwd: "/repo/next",
      promptSeq: 2,
    });
    expect(observation).toMatchObject({
      result: "ok",
      owner: {
        kind: "shell",
        revision: 2,
      },
      action: {
        kind: "write_text",
        preview: "echo ok\n",
      },
      events: [{ kind: "prompt" }],
    });
  });

  it("writes receiver stdin text through the PTY and advances on ack markers", async () => {
    const receiver: TerminalOwner = {
      kind: "receiver",
      revision: 4,
      receiverId: "rx-1",
      commandLine: "receiver start",
      mode: "base64",
      nextSeq: 0,
      bytesReceived: 0,
      maxFrameBytes: 4096,
    };
    const { ports, writes } = makePorts({
      snapshot: makeSnapshot(receiver),
      readChunk: "__TAH_RECEIVER_ACK__ nonce=nonce id=rx-1 seq=0 bytes=5\n",
    });
    const service = new TerminalService(ports, makeConfig());

    const observation = await service.handleAction({
      kind: "write_text",
      expectedOwnerRevision: 4,
      text: "aGVsbG8=\n",
    });

    expect(writes).toEqual(["aGVsbG8=\n"]);
    expect(observation.owner).toMatchObject({
      kind: "receiver",
      revision: 5,
      nextSeq: 1,
      bytesReceived: 5,
    });
    expect(observation.events).toEqual([
      { kind: "receiver_ack", receiverId: "rx-1", seq: 0, bytes: 5 },
    ]);
  });

  it("restarts through the PTY port and saves the fresh snapshot", async () => {
    const restarted = makeSnapshot(shell(0));
    const { ports, saves } = makePorts({ snapshot: makeSnapshot(shell(3)) });
    let restartCall: unknown;
    ports.pty.restart = async (session, options) => {
      restartCall = { session, options };
      return restarted;
    };
    const service = new TerminalService(ports, makeConfig());

    const observation = await service.handleAction({
      kind: "restart",
      cwd: "/tmp",
    });

    expect(restartCall).toEqual({ session: "default", options: { cwd: "/tmp" } });
    expect(saves).toEqual([restarted]);
    expect(observation).toMatchObject({
      result: "ok",
      owner: {
        kind: "shell",
        revision: 0,
      },
      action: {
        kind: "restart",
      },
    });
  });

  it("terminates through the PTY port and saves a terminated owner", async () => {
    const { ports, saves } = makePorts({ snapshot: makeSnapshot(shell(3)) });
    let terminatedSession: string | undefined;
    ports.pty.terminate = async (session) => {
      terminatedSession = session;
    };
    const service = new TerminalService(ports, makeConfig());

    const observation = await service.handleAction({
      kind: "terminate",
    });

    expect(terminatedSession).toBe("default");
    expect(saves[0]?.owner).toEqual({
      kind: "terminated",
      revision: 4,
      exitCode: null,
      reason: "terminated_by_action",
    });
    expect(observation.events).toEqual([{ kind: "terminated" }]);
  });
});
