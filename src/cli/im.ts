import * as crypto from "node:crypto";
import {
  createRunImSelfEndpoint,
  DEFAULT_RUN_USER_ENDPOINT,
  type PublicImPairKind,
  type PublicImMessageKind,
  type RuntimeImRequest,
  type RuntimeImResponse,
} from "../im/index.js";
import {
  RUNTIME_HOST_SOCKET_ENV,
  requestRuntimeReplicaIm,
} from "../runtime/runtime-replica.js";
import { failureEnvelope, successEnvelope } from "./envelope.js";

type StdinSource = AsyncIterable<string | Buffer | Uint8Array>;

type ParsedArgs = {
  flags: Record<string, string>;
  positional: string[];
};

type ImSubcommand =
  | "pair"
  | "bind"
  | "post"
  | "send"
  | "recv"
  | "ack"
  | "run-recv"
  | "run-ack"
  | "listen";

type ImClientRequest = {
  socketPath: string;
  request: RuntimeImRequest;
  timeoutMs: number;
};

export type ImCliDeps = {
  stdin: StdinSource;
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  env: Record<string, string | undefined>;
  timeoutMs: number;
  newRequestId: () => string;
  requestHost: (request: ImClientRequest) => Promise<RuntimeImResponse>;
  sleep: (ms: number) => Promise<void>;
};

type RunImOptions = Partial<ImCliDeps> & {
  stdin?: StdinSource;
};

const DEFAULT_RUNTIME_HOST_TIMEOUT_MS = 30_000;

class ImCliError extends Error {
  constructor(
    message: string,
    readonly errorCode = "IM_ERROR",
  ) {
    super(message);
  }
}

function defaultImCliDeps(options: RunImOptions = {}): ImCliDeps {
  return {
    stdin: options.stdin ?? (process.stdin as unknown as StdinSource),
    stdout: options.stdout ?? process.stdout,
    stderr: options.stderr ?? process.stderr,
    env: options.env ?? process.env,
    timeoutMs: options.timeoutMs ?? DEFAULT_RUNTIME_HOST_TIMEOUT_MS,
    newRequestId:
      options.newRequestId ?? (() => `im-cli-${crypto.randomUUID()}`),
    requestHost: options.requestHost ?? requestRuntimeReplicaIm,
    sleep:
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  };
}

function fail(message: string, errorCode = "IM_ERROR"): never {
  throw new ImCliError(message, errorCode);
}

function writeFailure(
  deps: Pick<ImCliDeps, "stderr">,
  errorCode: string,
  error: string,
): void {
  deps.stderr.write(
    `${JSON.stringify(failureEnvelope({ tool: "im", errorCode, error }))}\n`,
  );
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        flags[key] = "true";
      } else {
        flags[key] = value;
        i += 1;
      }
      continue;
    }
    positional.push(arg);
  }
  return { flags, positional };
}

function output(
  data: Record<string, unknown>,
  json: boolean,
  deps: Pick<ImCliDeps, "stdout"> = { stdout: process.stdout },
): void {
  if (json) {
    const envelope = successEnvelope({ tool: "im", extra: data });
    deps.stdout.write(`${JSON.stringify(envelope)}\n`);
    return;
  }

  for (const line of flatten(data)) {
    deps.stdout.write(`${line}\n`);
  }
}

function flatten(data: unknown, prefix = ""): string[] {
  if (data === null || data === undefined) return [];
  if (Array.isArray(data)) {
    return data.flatMap((item, i) => flatten(item, `${prefix}[${i}]`));
  }
  if (typeof data === "object") {
    return Object.entries(data as Record<string, unknown>).flatMap(([key, value]) => {
      const nextKey = prefix ? `${prefix}.${key}` : key;
      if (typeof value === "object" && value !== null) {
        return flatten(value, nextKey);
      }
      return [`${nextKey}=${String(value)}`];
    });
  }
  return [prefix ? `${prefix}=${String(data)}` : String(data)];
}

export async function runIm(
  argv: string[],
  options: RunImOptions = {},
): Promise<number> {
  const deps = defaultImCliDeps(options);
  const topLevel = argv[0];

  if (!topLevel || topLevel === "--help" || topLevel === "-h") {
    deps.stdout.write(imUsage());
    return 0;
  }

  if (!isImSubcommand(topLevel)) {
    writeFailure(deps, "IM_ERROR", imUsage());
    return 1;
  }

  try {
    await executeImClientCommand(topLevel, argv.slice(1), deps);
    return 0;
  } catch (error) {
    const errorCode = error instanceof ImCliError ? error.errorCode : "IM_ERROR";
    writeFailure(
      deps,
      errorCode,
      error instanceof Error ? error.message : String(error),
    );
    return 1;
  }
}

async function executeImClientCommand(
  subcommand: ImSubcommand,
  rest: string[],
  deps: ImCliDeps,
): Promise<void> {
  const parsed = parseArgs(rest);
  const jsonMode = parsed.flags.json === "true";
  const textStdin = parsed.flags["text-stdin"] === "true";
  delete parsed.flags.json;
  delete parsed.flags["text-stdin"];

  const clientOptions = parseImClientOptions(parsed.flags, deps.env);
  const timeoutMs = clientOptions.timeoutMs ?? deps.timeoutMs;

  if (!clientOptions.socketPath) {
    fail(
      `tiny-agent im requires a runtime replica socket. Set ${RUNTIME_HOST_SOCKET_ENV} or pass --runtime-host-socket <path>.`,
      "RUNTIME_HOST_NOT_FOUND",
    );
  }

  if (subcommand === "listen") {
    await cmdRuntimeListen(
      clientOptions.socketPath,
      timeoutMs,
      parsed.flags,
      jsonMode,
      textStdin,
      deps,
    );
    return;
  }

  const request = await buildRuntimeImRequest({
    subcommand,
    flags: parsed.flags,
    env: deps.env,
    textStdin,
    stdin: deps.stdin,
    newRequestId: deps.newRequestId,
  });
  const data = await requestRuntimeImCommand({
    socketPath: clientOptions.socketPath,
    timeoutMs,
    request,
    deps,
  });
  output(data, jsonMode, deps);
}

function parseImClientOptions(
  flags: Record<string, string>,
  env: Record<string, string | undefined>,
): {
  socketPath?: string;
  timeoutMs?: number;
} {
  let socketPath = env[RUNTIME_HOST_SOCKET_ENV];
  let timeoutMs: number | undefined;

  if (flags["runtime-host-socket"] !== undefined) {
    const value = flags["runtime-host-socket"];
    if (!value || value === "true") {
      fail("Usage: tiny-agent im <command> --runtime-host-socket <path>");
    }
    socketPath = value;
    delete flags["runtime-host-socket"];
  }

  if (flags["host-socket"] !== undefined) {
    fail("tiny-agent im no longer accepts --host-socket; use --runtime-host-socket <path>.");
  }

  if (flags["host-timeout-ms"] !== undefined) {
    const value = flags["host-timeout-ms"];
    if (!value || value === "true") {
      fail("Usage: tiny-agent im <command> --host-timeout-ms <ms>");
    }
    timeoutMs = parsePositiveInteger(value, "--host-timeout-ms");
    delete flags["host-timeout-ms"];
  }

  if (flags["state-dir"] !== undefined) {
    fail(
      "tiny-agent im does not accept --state-dir; start a runtime replica edge and pass --runtime-host-socket <path>.",
      "IM_STATE_DIR_NOT_ALLOWED",
    );
  }

  return { socketPath, timeoutMs };
}

async function buildRuntimeImRequest(options: {
  subcommand: Exclude<ImSubcommand, "listen">;
  flags: Record<string, string>;
  env: Record<string, string | undefined>;
  textStdin: boolean;
  stdin: StdinSource;
  newRequestId: () => string;
}): Promise<RuntimeImRequest> {
  const base = {
    schemaVersion: 1 as const,
    id: options.newRequestId(),
  };

  switch (options.subcommand) {
    case "pair":
      return {
        ...base,
        type: "im.pair",
        a: requiredClientFlag(options.flags, "a", "tiny-agent im pair requires --a and --b"),
        b: requiredClientFlag(options.flags, "b", "tiny-agent im pair requires --a and --b"),
        kind: options.flags.kind as PublicImPairKind | undefined,
      };
    case "bind":
      return {
        ...base,
        type: "im.bind",
        runId: options.flags["run-id"] ?? requireRunId(options.env, "tiny-agent im bind requires --run-id outside a run"),
        self: options.flags.self ?? requireSelfEndpoint(options.env, "tiny-agent im bind requires --self outside a run"),
        peer: options.flags.peer ?? defaultUserEndpoint(options.env),
        kind: options.flags.kind as PublicImPairKind | undefined,
      };
    case "post":
      return {
        ...base,
        type: "im.post",
        from: options.flags.from ?? defaultUserEndpoint(options.env),
        to: options.flags.to ?? requireSelfEndpoint(options.env, "tiny-agent im post requires --to outside a run"),
        text: await resolveTextOption({
          flags: options.flags,
          textStdin: options.textStdin,
          stdin: options.stdin,
          command: "post",
        }),
        metadata: { source: "cli" },
      };
    case "send": {
      const kind = requiredClientFlag(
        options.flags,
        "kind",
        "tiny-agent im send requires --kind",
      ) as Exclude<PublicImMessageKind, "message">;
      if (kind !== "status" && kind !== "error") {
        fail("--kind must be one of: status, error");
      }
      return {
        ...base,
        type: "im.send",
        from: options.flags.from ?? requireSelfEndpoint(options.env, "tiny-agent im send requires --from outside a run"),
        to: options.flags.to ?? defaultUserEndpoint(options.env),
        kind,
        text: await resolveTextOption({
          flags: options.flags,
          textStdin: options.textStdin,
          stdin: options.stdin,
          command: "send",
        }),
        metadata: { source: "cli" },
      };
    }
    case "recv":
      return {
        ...base,
        type: "im.recv",
        as: options.flags.as ?? requireSelfEndpoint(options.env, "tiny-agent im recv requires --as outside a run"),
        with: options.flags.with ?? defaultUserEndpoint(options.env),
        cursor: options.flags.cursor,
      };
    case "ack":
      return {
        ...base,
        type: "im.ack",
        as: options.flags.as ?? requireSelfEndpoint(options.env, "tiny-agent im ack requires --as outside a run"),
        with: options.flags.with ?? defaultUserEndpoint(options.env),
        messageId: requiredClientFlag(
          options.flags,
          "message-id",
          "tiny-agent im ack requires --message-id",
        ),
      };
    case "run-recv":
      return {
        ...base,
        type: "im.run-recv",
        runId: options.flags["run-id"] ?? requireRunId(options.env, "tiny-agent im run-recv requires --run-id outside a run"),
      };
    case "run-ack":
      return {
        ...base,
        type: "im.run-ack",
        runId: options.flags["run-id"] ?? requireRunId(options.env, "tiny-agent im run-ack requires --run-id outside a run"),
        peer: options.flags.peer ?? defaultUserEndpoint(options.env),
        messageId: requiredClientFlag(
          options.flags,
          "message-id",
          "tiny-agent im run-ack requires --message-id",
        ),
      };
  }
}

async function cmdRuntimeListen(
  socketPath: string,
  timeoutMs: number,
  flags: Record<string, string>,
  json: boolean,
  textStdin: boolean,
  deps: ImCliDeps,
): Promise<void> {
  if (textStdin) {
    fail("tiny-agent im listen does not accept --text-stdin");
  }
  let cursor = flags.cursor;

  if (!json) {
    deps.stdout.write("[im] Listening on runtime replica\n");
    deps.stdout.write("[im] Press Ctrl+C to stop\n");
  }

  let stopped = false;
  const onExit = () => {
    stopped = true;
  };
  process.once("SIGINT", onExit);
  process.once("SIGTERM", onExit);

  try {
    while (!stopped) {
      const request: RuntimeImRequest = {
        schemaVersion: 1,
        id: deps.newRequestId(),
        type: "im.recv",
        as: flags.as ?? requireSelfEndpoint(deps.env, "tiny-agent im listen requires --as outside a run"),
        with: flags.with ?? defaultUserEndpoint(deps.env),
        cursor,
      };
      const data = await requestRuntimeImCommand({
        socketPath,
        timeoutMs,
        request,
        deps,
      });

      for (const message of asMessages(data.messages)) {
        if (json) {
          deps.stdout.write(`${JSON.stringify(message)}\n`);
        } else {
          deps.stdout.write(
            `[${String(message.createdAt)}] ${String(message.from)}: ${String(message.text)}\n`,
          );
        }
      }

      if (typeof data.nextCursor === "string") {
        cursor = data.nextCursor;
      }

      await deps.sleep(500);
    }
  } finally {
    process.removeListener("SIGINT", onExit);
    process.removeListener("SIGTERM", onExit);
  }
}

async function requestRuntimeImCommand(options: {
  socketPath: string;
  timeoutMs: number;
  request: RuntimeImRequest;
  deps: Pick<ImCliDeps, "requestHost">;
}): Promise<Record<string, unknown>> {
  const response = await options.deps.requestHost({
    socketPath: options.socketPath,
    timeoutMs: options.timeoutMs,
    request: options.request,
  });

  if (response.type === "im.error") {
    fail(response.error.message, response.error.code);
  }
  if (response.type !== "im.result") {
    fail(
      `Unexpected runtime IM response: ${String((response as { type?: unknown }).type)}`,
      "RUNTIME_IM_ERROR",
    );
  }
  if (!isRecord(response.data)) {
    fail("Invalid runtime IM response: data must be an object", "RUNTIME_IM_ERROR");
  }
  if (
    (options.request.type === "im.recv" || options.request.type === "im.run-recv") &&
    response.data.cursorFound === false
  ) {
    fail(
      `tiny-agent im recv cursor was not found: ${
        options.request.type === "im.recv" ? options.request.cursor : ""
      }`,
      "IM_CURSOR_NOT_FOUND",
    );
  }
  return response.data;
}

function requiredClientFlag(
  flags: Record<string, string>,
  name: string,
  message: string,
): string {
  const value = flags[name];
  if (value === undefined || value.length === 0 || value === "true") {
    fail(message);
  }
  return value;
}

function requireRunId(
  env: Record<string, string | undefined>,
  message: string,
): string {
  const runId = env.TAH_IM_RUN_ID ?? env.TAH_RUN_ID;
  if (!runId || runId.length === 0) {
    fail(message);
  }
  return runId;
}

function requireSelfEndpoint(
  env: Record<string, string | undefined>,
  message: string,
): string {
  const endpoint =
    env.TAH_IM_SELF_ENDPOINT ??
    (env.TAH_IM_RUN_ID || env.TAH_RUN_ID
      ? createRunImSelfEndpoint((env.TAH_IM_RUN_ID ?? env.TAH_RUN_ID)!)
      : undefined);
  if (!endpoint || endpoint.length === 0) {
    fail(message);
  }
  return endpoint;
}

function defaultUserEndpoint(env: Record<string, string | undefined>): string {
  return env.TAH_IM_USER_ENDPOINT ?? DEFAULT_RUN_USER_ENDPOINT;
}

async function resolveTextOption(options: {
  flags: Record<string, string>;
  textStdin: boolean;
  stdin: StdinSource;
  command: "post" | "send";
}): Promise<string> {
  if (options.flags.text !== undefined && options.textStdin) {
    fail(
      `tiny-agent im ${options.command} accepts either --text or --text-stdin, not both`,
    );
  }
  const text =
    options.flags.text ??
    (options.textStdin ? await readStdinText(options.stdin) : undefined);
  if (text === undefined || text.length === 0) {
    fail(`tiny-agent im ${options.command} requires --text or --text-stdin`);
  }
  return text;
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    fail(`${flag} must be a positive integer`);
  }
  return parsed;
}

function asMessages(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isImSubcommand(value: string | undefined): value is ImSubcommand {
  return (
    value === "pair" ||
    value === "bind" ||
    value === "post" ||
    value === "send" ||
    value === "recv" ||
    value === "ack" ||
    value === "run-recv" ||
    value === "run-ack" ||
    value === "listen"
  );
}

function imUsage(): string {
  return (
    "Usage: tiny-agent im <send|recv|ack|run-recv|run-ack|listen> [--runtime-host-socket <path>] [options]\n" +
    "Runtime-host client commands:\n" +
    "  tiny-agent im pair --a <endpoint> --b <endpoint> [--kind <kind>] [--json]\n" +
    "  tiny-agent im bind [--run-id <id>] [--self <endpoint>] [--peer <endpoint>] [--kind <kind>] [--json]\n" +
    "  tiny-agent im post [--from <endpoint>] [--to <endpoint>] (--text <text>|--text-stdin) [--json]\n" +
    "  tiny-agent im send [--from <endpoint>] [--to <endpoint>] --kind <status|error> (--text <text>|--text-stdin) [--json]\n" +
    "  tiny-agent im recv [--as <endpoint>] [--with <endpoint>] [--cursor <id>] [--json]\n" +
    "  tiny-agent im ack [--as <endpoint>] [--with <endpoint>] --message-id <id> [--json]\n" +
    "  tiny-agent im run-recv [--run-id <id>] [--json]\n" +
    "  tiny-agent im run-ack [--run-id <id>] [--peer <endpoint>] --message-id <id> [--json]\n" +
    "  tiny-agent im listen [--as <endpoint>] [--with <endpoint>] [--cursor <id>] [--json]\n" +
    `Commands require ${RUNTIME_HOST_SOCKET_ENV} or --runtime-host-socket. External edges should start tiny-agent runtime replica --mode edge and pass its socket.`
  );
}

async function readStdinText(stdin: StdinSource): Promise<string> {
  let text = "";
  for await (const chunk of stdin) {
    text += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
  }
  return text;
}
