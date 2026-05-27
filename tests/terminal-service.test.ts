import { describe, expect, it } from "vitest";
import { TerminalService } from "../src/application/terminal-service.js";
import type {
  TerminalRuntimeSnapshot,
  TerminalServiceConfig,
  TerminalServicePorts,
} from "../src/application/terminal-ports.js";
import { createTerminalState } from "../src/terminal/state.js";
import type { TerminalState } from "../src/terminal/index.js";

function terminal(inputSeq = 1): TerminalState {
  return createTerminalState({
    inputSeq,
    cwd: "/repo",
    promptSeq: 1,
    lastReturnCode: 0,
  });
}

function makeSnapshot(state: TerminalState = terminal()): TerminalRuntimeSnapshot {
  return {
    session: "default",
    terminal: state,
    parserState: { pending: "", totalBytes: 0 },
  };
}

function makeConfig(): TerminalServiceConfig {
  return {
    defaultSessionId: "default",
    promptNonce: "nonce",
    actionLimits: {},
    observationLimits: {
      maxPreviewChars: 80,
      maxEvents: 50,
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
        restart: async () => makeSnapshot(terminal(0)),
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
  it("rejects stale input sequences without writing or saving", async () => {
    const { ports, writes, saves } = makePorts({ snapshot: makeSnapshot(terminal(2)) });
    const service = new TerminalService(ports, makeConfig());

    const observation = await service.handleAction({
      kind: "write_text",
      expectedInputSeq: 1,
      text: "echo stale",
    });

    expect(observation).toMatchObject({
      result: "rejected",
      errorCode: "INPUT_SEQ_MISMATCH",
    });
    expect(writes).toEqual([]);
    expect(saves).toEqual([]);
  });

  it("writes input, parses prompt output, saves snapshot, and returns compact observation", async () => {
    const { ports, writes, saves } = makePorts({
      snapshot: makeSnapshot(terminal(1)),
      readChunk: "__TAH_PROMPT__ nonce=nonce rc=0 cwd=%2Frepo%2Fnext seq=2\n",
    });
    const service = new TerminalService(ports, makeConfig());

    const observation = await service.handleAction({
      kind: "write_text",
      expectedInputSeq: 1,
      text: "echo ok\n",
    });

    expect(writes).toEqual(["echo ok\n"]);
    expect(saves).toHaveLength(1);
    expect(saves[0]?.terminal).toMatchObject({
      inputSeq: 2,
      lastShellPrompt: {
        cwd: "/repo/next",
        promptSeq: 2,
      },
    });
    expect(observation).toMatchObject({
      result: "ok",
      terminal: {
        inputSeq: 2,
        lastShellPrompt: {
          cwd: "/repo/next",
          promptSeq: 2,
        },
      },
      action: {
        kind: "write_text",
        preview: "echo ok\n",
      },
      events: [{ kind: "prompt" }],
    });
  });

  it("surfaces partial PTY output without waiting for a newline", async () => {
    const { ports, saves } = makePorts({
      snapshot: makeSnapshot(terminal(1)),
      readChunk: ">>> ",
    });
    const service = new TerminalService(ports, makeConfig());

    const observation = await service.handleAction({
      kind: "poll",
    });

    expect(saves[0]?.terminal.inputSeq).toBe(2);
    expect(saves[0]?.parserState.pending).toBe(">>> ");
    expect(observation).toMatchObject({
      result: "ok",
      terminal: {
        inputSeq: 2,
      },
      events: [],
      outputPreview: ">>> ",
    });
  });

  it("restarts through the PTY port and saves the fresh snapshot", async () => {
    const restarted = makeSnapshot(terminal(0));
    const { ports, saves } = makePorts({ snapshot: makeSnapshot(terminal(3)) });
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
      terminal: {
        inputSeq: 0,
      },
      action: {
        kind: "restart",
      },
    });
  });

  it("terminates through the PTY port and saves a terminated terminal", async () => {
    const { ports, saves } = makePorts({ snapshot: makeSnapshot(terminal(3)) });
    let terminatedSession: string | undefined;
    ports.pty.terminate = async (session) => {
      terminatedSession = session;
    };
    const service = new TerminalService(ports, makeConfig());

    const observation = await service.handleAction({
      kind: "terminate",
    });

    expect(terminatedSession).toBe("default");
    expect(saves[0]?.terminal).toMatchObject({
      inputSeq: 4,
      alive: false,
      termination: {
        exitCode: null,
        reason: "terminated_by_action",
      },
    });
    expect(observation.events).toEqual([{ kind: "terminated" }]);
  });
});
