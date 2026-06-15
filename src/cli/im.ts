import * as crypto from "node:crypto";
import * as path from "node:path";
import {
  PublicImService,
  createNodeImStore,
  type PublicImPairKind,
  type PublicImMessageKind,
  type ImHostRequest,
  type ImHostResponse,
  requestImHostSocket,
  runImHostCli,
} from "../im/index.js";
import { StateRootResolver } from "../state/root.js";
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
  request: ImHostRequest;
  timeoutMs: number;
};

export type ImCliDeps = {
  stdin: StdinSource;
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  env: Record<string, string | undefined>;
  timeoutMs: number;
  newRequestId: () => string;
  requestHost: (request: ImClientRequest) => Promise<ImHostResponse>;
  sleep: (ms: number) => Promise<void>;
};

type RunImOptions = Partial<ImCliDeps> & {
  stdin?: StdinSource;
};

const DEFAULT_IM_HOST_TIMEOUT_MS = 30_000;

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
    timeoutMs: options.timeoutMs ?? DEFAULT_IM_HOST_TIMEOUT_MS,
    newRequestId:
      options.newRequestId ?? (() => `im-cli-${crypto.randomUUID()}`),
    requestHost: options.requestHost ?? requestImHostSocket,
    sleep:
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  };
}

function die(message: string, errorCode = "IM_ERROR"): never {
  throw new ImCliError(message, errorCode);
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

  if (topLevel === "host") {
    try {
      return await runImHostCli(argv.slice(1));
    } catch (error) {
      writeFailure(
        deps,
        "IM_HOST_ERROR",
        error instanceof Error ? error.message : String(error),
      );
      return 1;
    }
  }

  if (!topLevel || topLevel === "--help" || topLevel === "-h") {
    deps.stdout.write(imUsage());
    return 0;
  }

  if (topLevel === "admin") {
    try {
      await executeImAdminCommand(argv.slice(1), deps);
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

async function executeImAdminCommand(
  argv: string[],
  deps: ImCliDeps,
): Promise<void> {
  const subcommand = argv[0];
  const rest = argv.slice(1);

  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    deps.stdout.write(adminUsage());
    return;
  }
  if (!isImSubcommand(subcommand)) {
    fail(adminUsage());
  }

  const parsed = parseArgs(rest);
  const jsonMode = parsed.flags.json === "true";
  const textStdin = parsed.flags["text-stdin"] === "true";
  delete parsed.flags.json;
  delete parsed.flags["text-stdin"];

  if (parsed.flags["host-socket"] !== undefined) {
    fail("tiny-agent im admin does not accept --host-socket; admin is the explicit direct-file boundary.");
  }
  if (parsed.flags["host-timeout-ms"] !== undefined) {
    fail("tiny-agent im admin does not accept --host-timeout-ms; admin is the explicit direct-file boundary.");
  }

  const stateRoot = resolveStateDir(parsed.flags["state-dir"], deps.env);
  delete parsed.flags["state-dir"];
  const service = createCliPublicImService();

  switch (subcommand) {
    case "pair":
      await cmdPair(service, stateRoot, parsed.flags, jsonMode, deps);
      break;
    case "bind":
      await cmdBind(service, stateRoot, parsed.flags, jsonMode, deps);
      break;
    case "post":
      await cmdPost(
        service,
        stateRoot,
        parsed.flags,
        jsonMode,
        textStdin,
        deps.stdin,
        deps,
      );
      break;
    case "send":
      await cmdSend(
        service,
        stateRoot,
        parsed.flags,
        jsonMode,
        textStdin,
        deps.stdin,
        deps,
      );
      break;
    case "recv":
      await cmdRecv(service, stateRoot, parsed.flags, jsonMode, deps);
      break;
    case "ack":
      await cmdAck(service, stateRoot, parsed.flags, jsonMode, deps);
      break;
    case "run-recv":
      await cmdRunRecv(service, stateRoot, parsed.flags, jsonMode, deps);
      break;
    case "run-ack":
      await cmdRunAck(service, stateRoot, parsed.flags, jsonMode, deps);
      break;
    case "listen":
      if (textStdin) {
        fail("tiny-agent im admin listen does not accept --text-stdin");
      }
      await cmdListen(service, stateRoot, parsed.flags, jsonMode, deps);
      break;
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
      "tiny-agent im requires a run-scoped IM host socket. Set TAH_IM_HOST_SOCKET or pass --host-socket <path>.",
      "IM_HOST_NOT_FOUND",
    );
  }

  if (subcommand === "listen") {
    await cmdHostListen(
      clientOptions.socketPath,
      timeoutMs,
      parsed.flags,
      jsonMode,
      textStdin,
      deps,
    );
    return;
  }

  const request = await buildImHostRequest({
    subcommand,
    flags: parsed.flags,
    textStdin,
    stdin: deps.stdin,
    newRequestId: deps.newRequestId,
  });
  const data = await requestImHostCommand({
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
  let socketPath = env.TAH_IM_HOST_SOCKET;
  let timeoutMs: number | undefined;

  if (flags["host-socket"] !== undefined) {
    const value = flags["host-socket"];
    if (!value || value === "true") {
      fail("Usage: tiny-agent im <command> --host-socket <path>");
    }
    socketPath = value;
    delete flags["host-socket"];
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
      "tiny-agent im ordinary commands do not accept --state-dir; start an im host with --state-dir or use the explicit admin boundary.",
      "IM_STATE_DIR_NOT_ALLOWED",
    );
  }

  return { socketPath, timeoutMs };
}

async function buildImHostRequest(options: {
  subcommand: Exclude<ImSubcommand, "listen">;
  flags: Record<string, string>;
  textStdin: boolean;
  stdin: StdinSource;
  newRequestId: () => string;
}): Promise<ImHostRequest> {
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
        runId: options.flags["run-id"],
        self: options.flags.self,
        peer: options.flags.peer,
        kind: options.flags.kind as PublicImPairKind | undefined,
      };
    case "post":
      return {
        ...base,
        type: "im.post",
        from: options.flags.from,
        to: options.flags.to,
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
        from: options.flags.from,
        to: options.flags.to,
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
        as: options.flags.as,
        with: options.flags.with,
        cursor: options.flags.cursor,
      };
    case "ack":
      return {
        ...base,
        type: "im.ack",
        as: options.flags.as,
        with: options.flags.with,
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
        runId: options.flags["run-id"],
      };
    case "run-ack":
      return {
        ...base,
        type: "im.run-ack",
        runId: options.flags["run-id"],
        peer: options.flags.peer,
        messageId: requiredClientFlag(
          options.flags,
          "message-id",
          "tiny-agent im run-ack requires --message-id",
        ),
      };
  }
}

async function cmdHostListen(
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
    deps.stdout.write("[im] Listening on run-scoped IM host\n");
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
      const request: ImHostRequest = {
        schemaVersion: 1,
        id: deps.newRequestId(),
        type: "im.recv",
        as: flags.as,
        with: flags.with,
        cursor,
      };
      const data = await requestImHostCommand({
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

async function requestImHostCommand(options: {
  socketPath: string;
  timeoutMs: number;
  request: ImHostRequest;
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
    fail(`Unexpected IM host response: ${response.type}`, "IM_HOST_ERROR");
  }
  if (!isRecord(response.data)) {
    fail("Invalid IM host response: data must be an object", "IM_HOST_ERROR");
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
    "Usage: tiny-agent im <send|recv|ack|run-recv|run-ack|listen> [--host-socket <path>] [options]\n" +
    "       tiny-agent im host --socket <path> --state-dir <dir> [--run-id <id>] [--self <endpoint>] [--user <endpoint>]\n" +
    "       tiny-agent im admin <pair|bind|post|send|recv|ack|run-recv|run-ack|listen> [--state-dir <dir>] [options]\n" +
    "Run-host client commands:\n" +
    "  tiny-agent im send [--from <endpoint>] [--to <endpoint>] --kind <status|error> (--text <text>|--text-stdin) [--json]\n" +
    "  tiny-agent im recv [--as <endpoint>] [--with <endpoint>] [--cursor <id>] [--json]\n" +
    "  tiny-agent im ack [--as <endpoint>] [--with <endpoint>] --message-id <id> [--json]\n" +
    "  tiny-agent im run-recv [--run-id <id>] [--json]\n" +
    "  tiny-agent im run-ack [--run-id <id>] [--peer <endpoint>] --message-id <id> [--json]\n" +
    "  tiny-agent im listen [--as <endpoint>] [--with <endpoint>] [--cursor <id>] [--json]\n" +
    "Direct-file admin examples:\n" +
    "  tiny-agent im admin pair --a <endpoint> --b <endpoint> [--kind <kind>] [--json]\n" +
    "  tiny-agent im admin bind --run-id <id> --self <endpoint> --peer <endpoint> [--kind <kind>] [--json]\n" +
    "  tiny-agent im admin post --from <endpoint> --to <endpoint> (--text <text>|--text-stdin) [--json]\n" +
    "Ordinary commands require TAH_IM_HOST_SOCKET or --host-socket. Direct file access is reserved for the explicit admin boundary."
  );
}

function adminUsage(): string {
  return (
    "Usage: tiny-agent im admin <pair|bind|post|send|recv|ack|run-recv|run-ack|listen> [--state-dir <dir>] [options]\n" +
    "  tiny-agent im admin pair --a <endpoint> --b <endpoint> [--kind <kind>] [--json]\n" +
    "  tiny-agent im admin bind --run-id <id> --self <endpoint> --peer <endpoint> [--kind <kind>] [--json]\n" +
    "  tiny-agent im admin post --from <endpoint> --to <endpoint> (--text <text>|--text-stdin) [--json]\n" +
    "  tiny-agent im admin send --from <endpoint> --to <endpoint> --kind <status|error> (--text <text>|--text-stdin) [--json]\n" +
    "  tiny-agent im admin recv --as <endpoint> --with <endpoint> [--cursor <id>] [--json]\n" +
    "  tiny-agent im admin ack --as <endpoint> --with <endpoint> --message-id <id> [--json]\n" +
    "  tiny-agent im admin run-recv --run-id <id> [--json]\n" +
    "  tiny-agent im admin run-ack --run-id <id> --peer <endpoint> --message-id <id> [--json]\n" +
    "Admin commands read/write public IM files directly and are for bootstrap/debug/user edges, not agent runtime replies."
  );
}

function resolveStateDir(
  explicitStateDir: string | undefined,
  env: Record<string, string | undefined> = process.env,
): string {
  if (explicitStateDir) {
    return path.resolve(explicitStateDir);
  }
  if (env.TAH_IM_STATE_DIR) {
    return path.resolve(env.TAH_IM_STATE_DIR);
  }
  if (env.TAH_STATE_DIR) {
    return path.resolve(env.TAH_STATE_DIR);
  }
  return new StateRootResolver().resolve().stateDir;
}

function createCliPublicImService(): PublicImService {
  return new PublicImService({
    store: createNodeImStore(),
    clock: { nowIso: () => new Date().toISOString() },
    ids: {
      newMessageId: (seed) => {
        const scope = seed.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "");
        return `im-${scope}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
      },
    },
  });
}

async function cmdPair(
  service: PublicImService,
  stateRoot: string,
  flags: Record<string, string>,
  json: boolean,
  deps: Pick<ImCliDeps, "stdout"> = { stdout: process.stdout },
): Promise<void> {
  const a = requiredFlag(flags, "a", "tiny-agent im admin pair requires --a and --b");
  const b = requiredFlag(flags, "b", "tiny-agent im admin pair requires --a and --b");
  const pair = await service.createPair({
    stateRoot,
    a,
    b,
    kind: flags.kind as PublicImPairKind | undefined,
  });
  output({ pair, stateRoot }, json, deps);
}

async function cmdBind(
  service: PublicImService,
  stateRoot: string,
  flags: Record<string, string>,
  json: boolean,
  deps: Pick<ImCliDeps, "stdout"> = { stdout: process.stdout },
): Promise<void> {
  const runId = requiredFlag(flags, "run-id", "tiny-agent im admin bind requires --run-id");
  const self = requiredFlag(flags, "self", "tiny-agent im admin bind requires --self");
  const peer = requiredFlag(flags, "peer", "tiny-agent im admin bind requires --peer");
  const binding = await service.bindRun({
    stateRoot,
    runId,
    self,
    peer,
    kind: flags.kind as PublicImPairKind | undefined,
  });
  output({ binding, stateRoot }, json, deps);
}

async function cmdPost(
  service: PublicImService,
  stateRoot: string,
  flags: Record<string, string>,
  json: boolean,
  textStdin: boolean,
  stdin: StdinSource,
  deps: Pick<ImCliDeps, "stdout"> = { stdout: process.stdout },
): Promise<void> {
  const from = requiredFlag(flags, "from", "tiny-agent im admin post requires --from");
  const to = requiredFlag(flags, "to", "tiny-agent im admin post requires --to");
  const text = await resolveTextOption({
    flags,
    textStdin,
    stdin,
    command: "post",
  });
  const message = await service.postMessage({
    stateRoot,
    from,
    to,
    text,
    metadata: { source: "cli" },
  });
  output({ message, id: message.id, from: message.from, to: message.to }, json, deps);
}

async function cmdSend(
  service: PublicImService,
  stateRoot: string,
  flags: Record<string, string>,
  json: boolean,
  textStdin: boolean,
  stdin: StdinSource,
  deps: Pick<ImCliDeps, "stdout"> = { stdout: process.stdout },
): Promise<void> {
  const from = requiredFlag(flags, "from", "tiny-agent im admin send requires --from");
  const to = requiredFlag(flags, "to", "tiny-agent im admin send requires --to");
  const kind = requiredFlag(flags, "kind", "tiny-agent im admin send requires --kind") as PublicImMessageKind;
  if (kind !== "status" && kind !== "error") {
    die("--kind must be one of: status, error");
  }
  const text = await resolveTextOption({
    flags,
    textStdin,
    stdin,
    command: "send",
  });

  const message = await service.sendMessage({
    stateRoot,
    from,
    to,
    kind,
    text,
    metadata: { source: "cli" },
  });
  output({ message, id: message.id, from: message.from, to: message.to, kind }, json, deps);
}

async function cmdRecv(
  service: PublicImService,
  stateRoot: string,
  flags: Record<string, string>,
  json: boolean,
  deps: Pick<ImCliDeps, "stdout"> = { stdout: process.stdout },
): Promise<void> {
  const as = requiredFlag(flags, "as", "tiny-agent im admin recv requires --as");
  const withEndpoint = requiredFlag(flags, "with", "tiny-agent im admin recv requires --with");
  const result = await service.receiveForPair({
    stateRoot,
    as,
    with: withEndpoint,
    cursor: flags.cursor,
  });
  if (result.cursorFound === false) {
    die(`tiny-agent im admin recv cursor was not found: ${flags.cursor}`, "IM_CURSOR_NOT_FOUND");
  }
  output(
    {
      as,
      with: withEndpoint,
      count: result.messages.length,
      nextCursor: result.nextCursor,
      messages: result.messages,
    },
    json,
    deps,
  );
}

async function cmdAck(
  service: PublicImService,
  stateRoot: string,
  flags: Record<string, string>,
  json: boolean,
  deps: Pick<ImCliDeps, "stdout"> = { stdout: process.stdout },
): Promise<void> {
  const as = requiredFlag(flags, "as", "tiny-agent im admin ack requires --as");
  const withEndpoint = requiredFlag(flags, "with", "tiny-agent im admin ack requires --with");
  const messageId = requiredFlag(flags, "message-id", "tiny-agent im admin ack requires --message-id");
  await service.ackPair({
    stateRoot,
    as,
    with: withEndpoint,
    messageId,
  });
  output({ as, with: withEndpoint, messageId }, json, deps);
}

async function cmdRunRecv(
  service: PublicImService,
  stateRoot: string,
  flags: Record<string, string>,
  json: boolean,
  deps: Pick<ImCliDeps, "stdout"> = { stdout: process.stdout },
): Promise<void> {
  const runId = requiredFlag(flags, "run-id", "tiny-agent im admin run-recv requires --run-id");
  const result = await service.receiveForRun({ stateRoot, runId });
  output(
    {
      runId: result.runId,
      self: result.self,
      count: result.messages.length,
      nextCursors: result.nextCursors,
      messages: result.messages,
    },
    json,
    deps,
  );
}

async function cmdRunAck(
  service: PublicImService,
  stateRoot: string,
  flags: Record<string, string>,
  json: boolean,
  deps: Pick<ImCliDeps, "stdout"> = { stdout: process.stdout },
): Promise<void> {
  const runId = requiredFlag(flags, "run-id", "tiny-agent im admin run-ack requires --run-id");
  const peer = requiredFlag(flags, "peer", "tiny-agent im admin run-ack requires --peer");
  const messageId = requiredFlag(flags, "message-id", "tiny-agent im admin run-ack requires --message-id");
  await service.ackRunChannel({
    stateRoot,
    runId,
    peer,
    messageId,
  });
  output({ runId, peer, messageId }, json, deps);
}

async function cmdListen(
  service: PublicImService,
  stateRoot: string,
  flags: Record<string, string>,
  json: boolean,
  deps: Pick<ImCliDeps, "stdout" | "sleep"> = {
    stdout: process.stdout,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  },
): Promise<void> {
  const as = requiredFlag(flags, "as", "tiny-agent im admin listen requires --as");
  const withEndpoint = requiredFlag(flags, "with", "tiny-agent im admin listen requires --with");
  let cursor = flags.cursor;

  if (!json) {
    deps.stdout.write(`[im] Listening as ${as} with ${withEndpoint}\n`);
    deps.stdout.write("[im] Press Ctrl+C to stop\n");
  }

  const onExit = () => process.exit(0);
  process.on("SIGINT", onExit);
  process.on("SIGTERM", onExit);

  while (true) {
    const result = await service.receiveForPair({
      stateRoot,
      as,
      with: withEndpoint,
      cursor,
    });
    if (result.cursorFound === false) {
      die(`tiny-agent im admin listen cursor was not found: ${cursor}`, "IM_CURSOR_NOT_FOUND");
    }

    for (const message of result.messages) {
      if (json) {
        deps.stdout.write(`${JSON.stringify(message)}\n`);
      } else {
        deps.stdout.write(`[${message.createdAt}] ${message.from}: ${message.text}\n`);
      }
    }

    if (result.nextCursor) {
      cursor = result.nextCursor;
    }

    await deps.sleep(500);
  }
}

function requiredFlag(
  flags: Record<string, string>,
  name: string,
  message: string,
): string {
  const value = flags[name];
  if (value === undefined || value.length === 0 || value === "true") {
    die(message);
  }
  return value;
}

async function readStdinText(stdin: StdinSource): Promise<string> {
  let text = "";
  for await (const chunk of stdin) {
    text += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
  }
  return text;
}
