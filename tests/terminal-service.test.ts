import { describe, expect, it } from "vitest";
import { formatPromptMarker } from "../src/application/managed-shell.js";
import { TerminalService } from "../src/application/terminal-service.js";
import type {
  PtyReadResult,
  TerminalRuntimeSnapshot,
  TerminalServiceConfig,
  TerminalServicePorts,
  PtyReadOptions,
} from "../src/application/terminal-ports.js";
import {
  createTerminalState,
  markTerminalTerminated,
} from "../src/terminal/state.js";
import type { TerminalScreen, TerminalState } from "../src/terminal/index.js";

function terminal(inputSeq = 1): TerminalState {
  return createTerminalState({
    inputSeq,
    cwd: "/repo",
    promptSeq: 1,
    lastReturnCode: 0,
  });
}

function makeSnapshot(
  session = "default",
  state: TerminalState = terminal(),
): TerminalRuntimeSnapshot {
  return {
    session,
    terminal: state,
    parserState: { pending: "", totalBytes: 0 },
  };
}

function makeScreen(session: string, text: string): TerminalScreen {
  return {
    text,
    rows: 24,
    cols: 80,
    truncated: false,
    logRef: { path: `.tiny-agent/sessions/${session}/output.log` },
  };
}

function makeConfig(): TerminalServiceConfig {
  return {
    defaultSessionId: "default",
    promptNonce: "nonce",
    screenRows: 24,
    screenCols: 80,
  };
}

function makeRead(session: string, chunk: string): PtyReadResult {
  return {
    chunk,
    logRef: { kind: "log", ref: `.tiny-agent/sessions/${session}/output.log` },
    screen: makeScreen(session, chunk),
  };
}

function makePorts(options: {
  currentSession?: string;
  snapshots?: TerminalRuntimeSnapshot[];
  reads?: Record<string, string[]>;
} = {}): {
  ports: TerminalServicePorts;
  current: () => string;
  writes: Array<{ session: string; data: string }>;
  readCalls: Array<{ session: string; cursor?: string; options?: PtyReadOptions }>;
  saves: TerminalRuntimeSnapshot[];
  restarts: Array<{ session: string; cwd?: string }>;
  interrupts: string[];
  terminates: string[];
} {
  let currentSession = options.currentSession ?? "default";
  const snapshots = new Map<string, TerminalRuntimeSnapshot>();
  for (const snapshot of options.snapshots ?? [makeSnapshot()]) {
    snapshots.set(snapshot.session, snapshot);
  }
  const reads = new Map<string, string[]>();
  for (const [session, chunks] of Object.entries(options.reads ?? {})) {
    reads.set(session, [...chunks]);
  }

  const writes: Array<{ session: string; data: string }> = [];
  const readCalls: Array<{ session: string; cursor?: string; options?: PtyReadOptions }> = [];
  const saves: TerminalRuntimeSnapshot[] = [];
  const restarts: Array<{ session: string; cwd?: string }> = [];
  const interrupts: string[] = [];
  const terminates: string[] = [];

  return {
    current: () => currentSession,
	    writes,
	    readCalls,
    saves,
    restarts,
    interrupts,
    terminates,
    ports: {
      pty: {
        write: async (session, data) => {
          writes.push({ session, data });
        },
	        read: async (session, cursor, readOptions) => {
	          readCalls.push({ session, cursor, options: readOptions });
	          const chunk = reads.get(session)?.shift() ?? "";
	          return makeRead(session, chunk);
	        },
        interrupt: async (session) => {
          interrupts.push(session);
        },
        terminate: async (session) => {
          terminates.push(session);
        },
        restart: async (session, restartOptions) => {
          restarts.push({ session, cwd: restartOptions?.cwd });
          const snapshot = makeSnapshot(session, terminal(0));
          snapshots.set(session, snapshot);
          return snapshot;
        },
      },
      sessions: {
        getCurrent: async () => currentSession,
        setCurrent: async (session) => {
          currentSession = session;
        },
        list: async () => [...snapshots.values()],
        load: async (session) => snapshots.get(session) ?? null,
        save: async (snapshot) => {
          snapshots.set(snapshot.session, snapshot);
          saves.push(snapshot);
        },
      },
      logger: {
        event: () => {},
      },
    },
  };
}

describe("TerminalService", () => {
  it("writes terminal_write input to the current session and returns a screen observation", async () => {
    const promptChunk =
      "ok\n" +
      formatPromptMarker({
        nonce: "nonce",
        returnCode: 0,
        cwd: "/repo/next",
        promptSeq: 2,
      }) +
      "\n";
    const { ports, writes, saves } = makePorts({
      currentSession: "work",
      snapshots: [makeSnapshot("work", terminal(1))],
      reads: { work: [promptChunk] },
    });
    const service = new TerminalService(ports, makeConfig());

    const observation = await service.handleAction({
      kind: "terminal_write",
      expectedInputSeq: 1,
      text: "echo ok\n",
    });

    expect(writes).toEqual([{ session: "work", data: "echo ok\n" }]);
    expect(saves).toHaveLength(1);
    expect(saves[0]?.terminal).toMatchObject({
      inputSeq: 2,
      lastShellPrompt: { cwd: "/repo/next", promptSeq: 2 },
    });
    expect(observation).toMatchObject({
      currentSession: "work",
      observedSession: "work",
      request: "terminal_write",
      result: "ok",
      returnedToPrompt: true,
      screen: {
        text: promptChunk,
        logRef: { path: ".tiny-agent/sessions/work/output.log" },
      },
    });
    expect(["output", "Tail"].join("") in observation).toBe(false);
    expect(["output", "Preview"].join("") in observation).toBe(false);
  });

  it("does not wait by default for command-like input", async () => {
    const { ports, readCalls } = makePorts({
      currentSession: "work",
      snapshots: [makeSnapshot("work", terminal(1))],
    });
    ports.pty.read = async (session, cursor, readOptions) => {
      readCalls.push({ session, cursor, options: readOptions });
      return makeRead(session, "still running\n");
    };
    const service = new TerminalService(ports, makeConfig());

    const observation = await service.handleAction({
      kind: "terminal_write",
      expectedInputSeq: 1,
      text: "npm test\n",
    });

    expect(readCalls[0]).toMatchObject({
      session: "work",
      cursor: "0",
      options: {
        waitForPromptMs: 0,
        afterPromptSeq: 1,
      },
    });
    expect(observation).toMatchObject({
      result: "ok",
      returnedToPrompt: false,
    });
  });

  it("honors explicit waitForReturnMs and can report timeout", async () => {
    const { ports, readCalls } = makePorts({
      currentSession: "work",
      snapshots: [makeSnapshot("work", terminal(1))],
    });
    ports.pty.read = async (session, cursor, readOptions) => {
      readCalls.push({ session, cursor, options: readOptions });
      return {
        ...makeRead(session, "still running\n"),
        timedOut: true,
      };
    };
    const service = new TerminalService(ports, makeConfig());

    const observation = await service.handleAction({
      kind: "terminal_write",
      expectedInputSeq: 1,
      text: "npm test\n",
      waitForReturnMs: 30_000,
    });

    expect(readCalls[0]).toMatchObject({
      session: "work",
      cursor: "0",
      options: {
        waitForPromptMs: 30_000,
        afterPromptSeq: 1,
      },
    });
    expect(observation).toMatchObject({
      result: "timeout",
      returnedToPrompt: false,
      message: expect.stringContaining("Timed out waiting 30000ms"),
    });
  });

  it("does not wait by default for partial terminal text", async () => {
    const { ports, readCalls } = makePorts({
      currentSession: "work",
      snapshots: [makeSnapshot("work", terminal(1))],
    });
    const service = new TerminalService(ports, makeConfig());

    await service.handleAction({
      kind: "terminal_write",
      expectedInputSeq: 1,
      text: "echo",
    });

    expect(readCalls[0]?.options?.waitForPromptMs).toBe(0);
  });

  it("rejects stale input sequences and refreshes the snapshot before reporting", async () => {
    const promptChunk =
      formatPromptMarker({
        nonce: "nonce",
        returnCode: 0,
        cwd: "/repo",
        promptSeq: 3,
      }) + "\n";
    const { ports, writes, saves } = makePorts({
      snapshots: [makeSnapshot("default", terminal(2))],
      reads: { default: [promptChunk] },
    });
    const service = new TerminalService(ports, makeConfig());

    const observation = await service.handleAction({
      kind: "terminal_write",
      expectedInputSeq: 1,
      text: "echo stale\n",
    });

    expect(writes).toEqual([]);
    expect(saves).toHaveLength(1);
    expect(saves[0]?.terminal.inputSeq).toBe(3);
    expect(observation).toMatchObject({
      result: "rejected",
      errorCode: "INPUT_SEQ_MISMATCH",
      terminal: { inputSeq: 3 },
      screen: { text: promptChunk },
    });
  });

  it("rejects input to a terminated current session before reaching the PTY", async () => {
    const deadTerminal = markTerminalTerminated(terminal(5), {
      exitCode: null,
      reason: "done",
    });
    const { ports, writes, interrupts, saves } = makePorts({
      snapshots: [makeSnapshot("default", deadTerminal)],
    });
    const service = new TerminalService(ports, makeConfig());

    const write = await service.handleAction({
      kind: "terminal_write",
      expectedInputSeq: deadTerminal.inputSeq,
      text: "pwd\n",
    });
    const key = await service.handleAction({
      kind: "terminal_key",
      expectedInputSeq: deadTerminal.inputSeq,
      key: "enter",
    });
    const interrupt = await service.handleAction({
      kind: "session_interrupt",
      expectedInputSeq: deadTerminal.inputSeq,
    });

    expect(writes).toEqual([]);
    expect(interrupts).toEqual([]);
    expect(saves.every((snapshot) => snapshot.terminal.alive === false)).toBe(true);
    for (const observation of [write, key, interrupt]) {
      expect(observation).toMatchObject({
        result: "rejected",
        errorCode: "TERMINAL_TERMINATED",
        terminal: {
          alive: false,
          termination: { reason: "done" },
        },
      });
    }
  });

  it("keeps a terminated session dead when later observation parses old prompt output", async () => {
    const promptChunk =
      formatPromptMarker({
        nonce: "nonce",
        returnCode: 0,
        cwd: "/repo/resurrect",
        promptSeq: 7,
      }) + "\n";
    const deadTerminal = markTerminalTerminated(terminal(5), {
      exitCode: null,
      reason: "done",
    });
    const { ports, saves } = makePorts({
      snapshots: [makeSnapshot("default", deadTerminal)],
      reads: { default: [promptChunk] },
    });
    const service = new TerminalService(ports, makeConfig());

    const observation = await service.handleAction({ kind: "session_observe" });

    expect(saves.at(-1)?.terminal).toMatchObject({
      alive: false,
      termination: { reason: "done" },
      lastShellPrompt: { cwd: "/repo/resurrect", promptSeq: 7 },
    });
    expect(observation).toMatchObject({
      result: "ok",
      terminal: {
        alive: false,
        termination: { reason: "done" },
      },
      screen: { text: promptChunk },
    });
  });

  it("uses current session for terminal_key and session_interrupt", async () => {
    const { ports, writes, interrupts } = makePorts({
      currentSession: "shell",
      snapshots: [makeSnapshot("shell", terminal(1))],
    });
    const service = new TerminalService(ports, makeConfig());

    await service.handleAction({
      kind: "terminal_key",
      expectedInputSeq: 1,
      key: "enter",
    });
    await service.handleAction({
      kind: "session_interrupt",
      expectedInputSeq: 2,
    });

    expect(writes[0]).toEqual({ session: "shell", data: "\n" });
    expect(interrupts).toEqual(["shell"]);
  });

  it("renders pager terminal_key values as literal key bytes", async () => {
    const { ports, writes } = makePorts({
      currentSession: "shell",
      snapshots: [makeSnapshot("shell", terminal(1))],
    });
    const service = new TerminalService(ports, makeConfig());

    await service.handleAction({
      kind: "terminal_key",
      expectedInputSeq: 1,
      key: "space",
    });
    await service.handleAction({
      kind: "terminal_key",
      expectedInputSeq: 2,
      key: "q",
    });

    expect(writes).toEqual([
      { session: "shell", data: " " },
      { session: "shell", data: "q" },
    ]);
  });

  it("observes a named session without changing focus", async () => {
    const { ports, current } = makePorts({
      currentSession: "default",
      snapshots: [
        makeSnapshot("default", terminal(1)),
        makeSnapshot("logs", terminal(5)),
      ],
      reads: { logs: ["tail\n"] },
    });
    const service = new TerminalService(ports, makeConfig());

    const observation = await service.handleAction({
      kind: "session_observe",
      session: "logs",
    });

    expect(current()).toBe("default");
    expect(observation).toMatchObject({
      currentSession: "default",
      observedSession: "logs",
      request: "session_observe",
      screen: { text: "tail\n" },
    });
  });

  it("focuses a newly created session and lists current session state", async () => {
    const { ports, current, restarts } = makePorts({
      currentSession: "default",
      snapshots: [makeSnapshot("default", terminal(1))],
    });
    const service = new TerminalService(ports, makeConfig());

    const focus = await service.handleAction({
      kind: "session_focus",
      session: "build",
      create: true,
      cwd: "/repo",
    });
    const list = await service.handleAction({ kind: "session_list" });

    expect(restarts).toEqual([{ session: "build", cwd: "/repo" }]);
    expect(current()).toBe("build");
    expect(focus).toMatchObject({
      currentSession: "build",
      request: "session_focus",
      result: "ok",
    });
    expect(list).toMatchObject({
      currentSession: "build",
    });
    if ("sessions" in list) {
      expect(list.sessions.map((session) => session.session).sort()).toEqual([
        "build",
        "default",
      ]);
    }
  });

  it("restarts and terminates the requested session", async () => {
    const { ports, restarts, terminates, saves } = makePorts({
      currentSession: "default",
      snapshots: [makeSnapshot("default", terminal(3))],
    });
    const service = new TerminalService(ports, makeConfig());

    const restart = await service.handleAction({
      kind: "session_restart",
      cwd: "/tmp",
    });
    const terminate = await service.handleAction({
      kind: "session_terminate",
      reason: "done",
    });

    expect(restarts).toEqual([{ session: "default", cwd: "/tmp" }]);
    expect(terminates).toEqual(["default"]);
    expect(saves.at(-1)?.terminal).toMatchObject({
      alive: false,
      termination: {
        exitCode: null,
        reason: "done",
      },
    });
    expect(restart).toMatchObject({ request: "session_restart", result: "ok" });
    expect(terminate).toMatchObject({
      request: "session_terminate",
      result: "ok",
      terminal: { alive: false },
    });
  });
});
