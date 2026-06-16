import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import type {
  RuntimeProcessKind,
  RuntimeProcessOwner,
  RuntimeProcessRecord,
} from "./process-registry.js";
import { createRuntimeProcess } from "./process-registry.js";
import type {
  RunSupervisor,
  SpawnedProcessPort,
} from "./run-supervisor.js";

export type ResidentSocketHostKind =
  | "terminal-host"
  | "codeq-host"
  | "skill-host"
  | "mcp-host"
  | "model-gateway";

export type ResidentHostPaths = {
  processId: string;
  socketPath: string;
  statePath: string;
  logPath: string;
};

export type ResidentHostPathsInput = {
  kind: ResidentSocketHostKind;
  runId: string;
  runDir: string;
  socketRoot: string;
  socketScope: string;
};

export const RESIDENT_HOST_SOCKET_PATH_MAX_BYTES = 100;

const RESIDENT_HOST_SOCKET_DIR_NAME = "ta-rh";

const RESIDENT_SOCKET_KIND_PREFIX: Record<ResidentSocketHostKind, string> = {
  "terminal-host": "term",
  "codeq-host": "codeq",
  "skill-host": "skill",
  "mcp-host": "mcp",
  "model-gateway": "model",
};

export type LaunchedResidentSocketHost = ResidentHostPaths & {
  dispose: () => Promise<void>;
};

export type ResidentHostSocketLineResult = {
  responseLine: string;
  afterResponse?: () => Promise<void> | void;
  close?: boolean;
};

export type ResidentHostSocketConnectionPort = {
  sendLine(line: string): void;
  close(): void;
  onClose(handler: () => void): void;
};

export type ResidentHostSocketLineHandler = (
  line: string,
  connection: ResidentHostSocketConnectionPort,
) => Promise<ResidentHostSocketLineResult>;

export function residentHostProcessId(
  kind: ResidentSocketHostKind,
  runId: string,
): string {
  assertRuntimeKind(kind);
  assertRunId(runId);
  return `${kind}:${runId}`;
}

export function defaultResidentSocketRoot(input: { tmpDir: string }): string {
  assertNonEmpty("Resident host tmpDir", input.tmpDir);
  return path.join(input.tmpDir, RESIDENT_HOST_SOCKET_DIR_NAME);
}

export function residentHostPaths(input: ResidentHostPathsInput): ResidentHostPaths {
  const processId = residentHostProcessId(input.kind, input.runId);
  const socketPath = residentHostSocketPath({
    kind: input.kind,
    runId: input.runId,
    socketRoot: input.socketRoot,
    socketScope: input.socketScope,
  });
  return {
    processId,
    socketPath,
    statePath: path.join(input.runDir, `${input.kind}.json`),
    logPath: path.join(input.runDir, `${input.kind}.stderr.log`),
  };
}

export function residentHostSocketPath(input: {
  kind: ResidentSocketHostKind;
  runId: string;
  socketRoot: string;
  socketScope: string;
}): string {
  assertRuntimeKind(input.kind);
  assertRunId(input.runId);
  assertNonEmpty("Resident host socketRoot", input.socketRoot);
  assertNonEmpty("Resident host socketScope", input.socketScope);

  const digest = createHash("sha256")
    .update(input.socketScope)
    .update("\0")
    .update(input.runId)
    .update("\0")
    .update(input.kind)
    .digest("hex")
    .slice(0, 16);
  const socketPath = path.join(
    input.socketRoot,
    `${RESIDENT_SOCKET_KIND_PREFIX[input.kind]}-${digest}.sock`,
  );
  assertResidentHostSocketPathBudget(socketPath);
  return socketPath;
}

export function createResidentHostProcessRecord(input: {
  kind: ResidentSocketHostKind;
  runId: string;
  socketPath: string;
  command: {
    executable: string;
    args: readonly string[];
    cwd: string;
    envKeys?: readonly string[];
  };
  now: string;
  statePath?: string;
  logPath?: string;
  metadata?: Record<string, string | number | boolean | null>;
}): RuntimeProcessRecord {
  assertRuntimeKind(input.kind);
  return createRuntimeProcess({
    id: residentHostProcessId(input.kind, input.runId),
    kind: input.kind,
    owner: { scope: "run", runId: input.runId },
    command: input.command,
    now: input.now,
    statePath: input.statePath,
    logPath: input.logPath,
    metadata: {
      runId: input.runId,
      socketPath: input.socketPath,
      ...(input.metadata ?? {}),
    },
  });
}

export type LaunchResidentSocketHostInput = {
  supervisor: Pick<RunSupervisor, "startProcess">;
  kind: ResidentSocketHostKind;
  processId: string;
  owner: Extract<RuntimeProcessOwner, { scope: "run" }>;
  executable: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  socketPath: string;
  statePath?: string;
  logPath?: string;
  startupTimeoutMs?: number;
  pollIntervalMs?: number;
  metadata?: Record<string, string | number | boolean | null>;
  nowEpochMs?: () => number;
  wait?: (ms: number) => Promise<void>;
  isSocketReady?: (socketPath: string) => boolean;
};

export async function launchResidentSocketHost(
  input: LaunchResidentSocketHostInput,
): Promise<LaunchedResidentSocketHost> {
  assertRuntimeKind(input.kind);
  const { child } = input.supervisor.startProcess({
    processId: input.processId,
    kind: input.kind,
    owner: input.owner,
    executable: input.executable,
    args: input.args,
    cwd: input.cwd,
    env: input.env,
    statePath: input.statePath,
    logPath: input.logPath,
    stdio: ["ignore", "pipe", "pipe"],
    metadata: {
      runId: input.owner.runId,
      socketPath: input.socketPath,
      ...(input.metadata ?? {}),
    },
  });

  let logStream: fs.WriteStream | undefined;
  if (input.logPath && child.stderr) {
    fs.mkdirSync(path.dirname(input.logPath), { recursive: true });
    logStream = fs.createWriteStream(input.logPath, { flags: "a" });
    logStream.on("error", () => {
      // Host stderr logs are diagnostic-only; process lifecycle is tracked separately.
    });
    child.stderr.pipe(logStream);
  }

  try {
    await waitForResidentHostSocket({
      child,
      socketPath: input.socketPath,
      timeoutMs: input.startupTimeoutMs ?? 5_000,
      pollIntervalMs: input.pollIntervalMs ?? 25,
      nowEpochMs: input.nowEpochMs ?? Date.now,
      wait: input.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      isSocketReady: input.isSocketReady ?? isSocketPathReady,
    });
  } catch (error) {
    if (logStream && child.stderr) {
      child.stderr.unpipe(logStream);
      await closeLogStream(logStream);
    }
    killResidentHost(child);
    throw error;
  }

  return {
    processId: input.processId,
    socketPath: input.socketPath,
    statePath: input.statePath ?? "",
    logPath: input.logPath ?? "",
    dispose: async () => {
      if (logStream && child.stderr) {
        child.stderr.unpipe(logStream);
        await closeLogStream(logStream);
      }
      killResidentHost(child);
    },
  };
}

export async function listenResidentHostSocket(options: {
  socketPath: string;
  handleLine: ResidentHostSocketLineHandler;
}): Promise<net.Server> {
  prepareResidentHostSocketPath(options.socketPath);
  const server = net.createServer((socket) => {
    handleResidentHostSocketConnection({
      socket,
      handleLine: async (line, connection) => {
        const result = await options.handleLine(line, connection);
        if (result.close) {
          server.close();
        }
        return result;
      },
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.socketPath);
  });

  server.once("close", () => {
    try {
      const stat = fs.lstatSync(options.socketPath);
      if (stat.isSocket()) {
        fs.unlinkSync(options.socketPath);
      }
    } catch {
      // Socket path may already be gone.
    }
  });

  return server;
}

export async function requestResidentHostJson<TResponse>(options: {
  socketPath: string;
  request: unknown;
  timeoutMs: number;
  parseResponse: (raw: string) => TResponse;
}): Promise<TResponse> {
  return await new Promise<TResponse>((resolve, reject) => {
    const socket = net.createConnection(options.socketPath);
    let buffer = "";
    let settled = false;

    const settle = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      callback();
    };

    const timer = setTimeout(() => {
      settle(() => {
        reject(new Error("Timed out waiting for resident host response"));
      });
    }, options.timeoutMs);

    socket.once("connect", () => {
      socket.write(`${JSON.stringify(options.request)}\n`);
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf-8");
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      const line = buffer.slice(0, newlineIndex);
      settle(() => {
        try {
          resolve(options.parseResponse(line));
        } catch (error) {
          reject(error);
        }
      });
    });

    socket.once("error", (error) => {
      settle(() => reject(error));
    });

    socket.once("end", () => {
      settle(() => reject(new Error("Resident host socket ended before response")));
    });
  });
}

export function prepareResidentHostSocketPath(socketPath: string): void {
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  try {
    const stat = fs.lstatSync(socketPath);
    if (!stat.isSocket()) {
      throw new Error(`Refusing to replace non-socket path: ${socketPath}`);
    }
    fs.unlinkSync(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

function handleResidentHostSocketConnection(options: {
  socket: net.Socket;
  handleLine: ResidentHostSocketLineHandler;
}): void {
  let buffer = "";
  const closeHandlers = new Set<() => void>();
  let closedForSend = false;
  let cleanupRan = false;
  const connection: ResidentHostSocketConnectionPort = {
    sendLine(line) {
      if (closedForSend || options.socket.destroyed) {
        return;
      }
      options.socket.write(`${line}\n`);
    },
    close() {
      closedForSend = true;
      options.socket.end();
    },
    onClose(handler) {
      if (cleanupRan) {
        handler();
        return;
      }
      closeHandlers.add(handler);
    },
  };
  const runCloseHandlers = () => {
    if (cleanupRan) {
      return;
    }
    cleanupRan = true;
    closedForSend = true;
    for (const handler of closeHandlers) {
      try {
        handler();
      } catch {
        // Connection cleanup is best-effort; host state must not depend on one cleanup handler.
      }
    }
    closeHandlers.clear();
  };
  options.socket.once("close", runCloseHandlers);
  options.socket.once("end", runCloseHandlers);
  options.socket.once("error", runCloseHandlers);
  options.socket.on("data", (chunk) => {
    buffer += chunk.toString("utf-8");
    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      void handleResidentHostSocketLine({ ...options, connection }, line);
    }
  });
}

async function handleResidentHostSocketLine(
  options: {
    socket: net.Socket;
    handleLine: ResidentHostSocketLineHandler;
    connection: ResidentHostSocketConnectionPort;
  },
  line: string,
): Promise<void> {
  if (line.trim().length === 0) {
    return;
  }
  try {
    const result = await options.handleLine(line, options.connection);
    options.connection.sendLine(result.responseLine);
    await result.afterResponse?.();
    if (result.close) {
      options.connection.close();
    }
  } catch (error) {
    options.connection.sendLine(
      JSON.stringify({
        schemaVersion: 1,
        id: "unknown",
        ok: false,
        type: "resident-host.error",
        error: {
          code: "HOST_ERROR",
          message: error instanceof Error ? error.message : String(error),
        },
      }),
    );
  }
}

async function waitForResidentHostSocket(input: {
  child: SpawnedProcessPort;
  socketPath: string;
  timeoutMs: number;
  pollIntervalMs: number;
  nowEpochMs: () => number;
  wait: (ms: number) => Promise<void>;
  isSocketReady: (socketPath: string) => boolean;
}): Promise<void> {
  const deadline = input.nowEpochMs() + input.timeoutMs;
  while (input.nowEpochMs() <= deadline) {
    if (input.isSocketReady(input.socketPath)) {
      return;
    }
    if (input.child.exitCode !== null && input.child.exitCode !== undefined) {
      throw new Error(
        `Resident host exited before socket was ready: ${input.socketPath}`,
      );
    }
    await input.wait(input.pollIntervalMs);
  }
  throw new Error(`Timed out waiting for resident host socket: ${input.socketPath}`);
}

function killResidentHost(child: SpawnedProcessPort): void {
  if (!child.killed && child.exitCode === null) {
    child.kill("SIGTERM");
  }
}

function isSocketPathReady(socketPath: string): boolean {
  try {
    return fs.lstatSync(socketPath).isSocket();
  } catch {
    return false;
  }
}

async function closeLogStream(stream: fs.WriteStream): Promise<void> {
  await new Promise<void>((resolve) => {
    stream.once("error", () => resolve());
    stream.end(() => resolve());
  });
}

function assertRunId(runId: string): void {
  if (runId.trim().length === 0) {
    throw new Error("Resident host runId must be non-empty");
  }
}

function assertNonEmpty(label: string, value: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${label} must be non-empty`);
  }
}

function assertResidentHostSocketPathBudget(socketPath: string): void {
  const byteLength = Buffer.byteLength(socketPath);
  if (byteLength > RESIDENT_HOST_SOCKET_PATH_MAX_BYTES) {
    throw new Error(
      `Resident host socket path is ${byteLength} bytes, exceeding ${RESIDENT_HOST_SOCKET_PATH_MAX_BYTES} byte budget: ${socketPath}`,
    );
  }
}

function assertRuntimeKind(kind: ResidentSocketHostKind): asserts kind is RuntimeProcessKind & ResidentSocketHostKind {
  if (
    kind !== "terminal-host" &&
    kind !== "codeq-host" &&
    kind !== "skill-host" &&
    kind !== "mcp-host" &&
    kind !== "model-gateway"
  ) {
    throw new Error(`Unsupported resident host kind: ${kind}`);
  }
}
