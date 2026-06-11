import * as crypto from "node:crypto";
import * as path from "node:path";
import {
  PublicImService,
  createNodeImStore,
  type PublicImPairKind,
  type PublicImMessageKind,
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

type RunImOptions = {
  stdin?: StdinSource;
};

function die(message: string, errorCode = "IM_ERROR"): never {
  const env = failureEnvelope({ tool: "im", errorCode, error: message });
  process.stderr.write(`${JSON.stringify(env)}\n`);
  process.exit(1);
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

function output(data: Record<string, unknown>, json: boolean): void {
  if (json) {
    const envelope = successEnvelope({ tool: "im", extra: data });
    process.stdout.write(`${JSON.stringify(envelope)}\n`);
    return;
  }

  for (const line of flatten(data)) {
    process.stdout.write(`${line}\n`);
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
): Promise<void> {
  const subcommand = argv[0];
  const rest = argv.slice(1);
  const parsed = parseArgs(rest);
  const jsonMode = parsed.flags.json === "true";
  const textStdin = parsed.flags["text-stdin"] === "true";
  delete parsed.flags.json;
  delete parsed.flags["text-stdin"];

  if (!isImSubcommand(subcommand)) {
    die(imUsage());
  }

  const stateRoot = resolveStateDir(parsed.flags["state-dir"]);
  delete parsed.flags["state-dir"];
  const service = createCliPublicImService();

  try {
    switch (subcommand) {
      case "pair":
        await cmdPair(service, stateRoot, parsed.flags, jsonMode);
        break;
      case "bind":
        await cmdBind(service, stateRoot, parsed.flags, jsonMode);
        break;
      case "post":
        await cmdPost(service, stateRoot, parsed.flags, jsonMode);
        break;
      case "send":
        await cmdSend(
          service,
          stateRoot,
          parsed.flags,
          jsonMode,
          textStdin,
          options.stdin ?? (process.stdin as unknown as StdinSource),
        );
        break;
      case "recv":
        await cmdRecv(service, stateRoot, parsed.flags, jsonMode);
        break;
      case "ack":
        await cmdAck(service, stateRoot, parsed.flags, jsonMode);
        break;
      case "run-recv":
        await cmdRunRecv(service, stateRoot, parsed.flags, jsonMode);
        break;
      case "run-ack":
        await cmdRunAck(service, stateRoot, parsed.flags, jsonMode);
        break;
      case "listen":
        await cmdListen(service, stateRoot, parsed.flags, jsonMode);
        break;
      default:
        subcommand satisfies never;
    }
  } catch (error) {
    if (error instanceof Error && /^process\.exit /.test(error.message)) {
      throw error;
    }
    die(error instanceof Error ? error.message : String(error));
  }
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
    "Usage: tiny-agent im <pair|bind|post|send|recv|ack|run-recv|run-ack|listen> [options]\n" +
    "  tiny-agent im pair --a <endpoint> --b <endpoint> [--kind <kind>] [--json]\n" +
    "  tiny-agent im bind --run-id <id> --self <endpoint> --peer <endpoint> [--kind <kind>] [--json]\n" +
    "  tiny-agent im post --from <endpoint> --to <endpoint> --text <text> [--json]\n" +
    "  tiny-agent im send --from <endpoint> --to <endpoint> --kind <status|error> (--text <text>|--text-stdin) [--json]\n" +
    "  tiny-agent im recv --as <endpoint> --with <endpoint> [--cursor <id>] [--json]\n" +
    "  tiny-agent im ack --as <endpoint> --with <endpoint> --message-id <id> [--json]\n" +
    "  tiny-agent im run-recv --run-id <id> [--json]\n" +
    "  tiny-agent im run-ack --run-id <id> --peer <endpoint> --message-id <id> [--json]\n" +
    "  tiny-agent im listen --as <endpoint> --with <endpoint> [--cursor <id>] [--json]"
  );
}

function resolveStateDir(explicitStateDir: string | undefined): string {
  if (explicitStateDir) {
    return path.resolve(explicitStateDir);
  }
  if (process.env.TAH_IM_STATE_DIR) {
    return path.resolve(process.env.TAH_IM_STATE_DIR);
  }
  if (process.env.TAH_STATE_DIR) {
    return path.resolve(process.env.TAH_STATE_DIR);
  }
  return new StateRootResolver().resolve().stateDir;
}

async function cmdPair(
  service: PublicImService,
  stateRoot: string,
  flags: Record<string, string>,
  json: boolean,
): Promise<void> {
  const a = requiredFlag(flags, "a", "tiny-agent im pair requires --a and --b");
  const b = requiredFlag(flags, "b", "tiny-agent im pair requires --a and --b");
  const pair = await service.createPair({
    stateRoot,
    a,
    b,
    kind: flags.kind as PublicImPairKind | undefined,
  });
  output({ pair, stateRoot }, json);
}

async function cmdBind(
  service: PublicImService,
  stateRoot: string,
  flags: Record<string, string>,
  json: boolean,
): Promise<void> {
  const runId = requiredFlag(flags, "run-id", "tiny-agent im bind requires --run-id");
  const self = requiredFlag(flags, "self", "tiny-agent im bind requires --self");
  const peer = requiredFlag(flags, "peer", "tiny-agent im bind requires --peer");
  const binding = await service.bindRun({
    stateRoot,
    runId,
    self,
    peer,
    kind: flags.kind as PublicImPairKind | undefined,
  });
  output({ binding, stateRoot }, json);
}

async function cmdPost(
  service: PublicImService,
  stateRoot: string,
  flags: Record<string, string>,
  json: boolean,
): Promise<void> {
  const from = requiredFlag(flags, "from", "tiny-agent im post requires --from");
  const to = requiredFlag(flags, "to", "tiny-agent im post requires --to");
  const text = requiredFlag(flags, "text", "tiny-agent im post requires --text");
  const message = await service.postMessage({
    stateRoot,
    from,
    to,
    text,
    metadata: { source: "cli" },
  });
  output({ message, id: message.id, from: message.from, to: message.to }, json);
}

async function cmdSend(
  service: PublicImService,
  stateRoot: string,
  flags: Record<string, string>,
  json: boolean,
  textStdin: boolean,
  stdin: StdinSource,
): Promise<void> {
  const from = requiredFlag(flags, "from", "tiny-agent im send requires --from");
  const to = requiredFlag(flags, "to", "tiny-agent im send requires --to");
  const kind = requiredFlag(flags, "kind", "tiny-agent im send requires --kind") as PublicImMessageKind;
  if (kind !== "status" && kind !== "error") {
    die("--kind must be one of: status, error");
  }
  if (flags.text !== undefined && textStdin) {
    die("tiny-agent im send accepts either --text or --text-stdin, not both");
  }
  const text = flags.text ?? (textStdin ? await readStdinText(stdin) : undefined);
  if (text === undefined || text.length === 0) {
    die("tiny-agent im send requires --text or --text-stdin");
  }

  const message = await service.sendMessage({
    stateRoot,
    from,
    to,
    kind,
    text,
    metadata: { source: "cli" },
  });
  output({ message, id: message.id, from: message.from, to: message.to, kind }, json);
}

async function cmdRecv(
  service: PublicImService,
  stateRoot: string,
  flags: Record<string, string>,
  json: boolean,
): Promise<void> {
  const as = requiredFlag(flags, "as", "tiny-agent im recv requires --as");
  const withEndpoint = requiredFlag(flags, "with", "tiny-agent im recv requires --with");
  const result = await service.receiveForPair({
    stateRoot,
    as,
    with: withEndpoint,
    cursor: flags.cursor,
  });
  if (result.cursorFound === false) {
    die(`tiny-agent im recv cursor was not found: ${flags.cursor}`, "IM_CURSOR_NOT_FOUND");
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
  );
}

async function cmdAck(
  service: PublicImService,
  stateRoot: string,
  flags: Record<string, string>,
  json: boolean,
): Promise<void> {
  const as = requiredFlag(flags, "as", "tiny-agent im ack requires --as");
  const withEndpoint = requiredFlag(flags, "with", "tiny-agent im ack requires --with");
  const messageId = requiredFlag(flags, "message-id", "tiny-agent im ack requires --message-id");
  await service.ackPair({
    stateRoot,
    as,
    with: withEndpoint,
    messageId,
  });
  output({ as, with: withEndpoint, messageId }, json);
}

async function cmdRunRecv(
  service: PublicImService,
  stateRoot: string,
  flags: Record<string, string>,
  json: boolean,
): Promise<void> {
  const runId = requiredFlag(flags, "run-id", "tiny-agent im run-recv requires --run-id");
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
  );
}

async function cmdRunAck(
  service: PublicImService,
  stateRoot: string,
  flags: Record<string, string>,
  json: boolean,
): Promise<void> {
  const runId = requiredFlag(flags, "run-id", "tiny-agent im run-ack requires --run-id");
  const peer = requiredFlag(flags, "peer", "tiny-agent im run-ack requires --peer");
  const messageId = requiredFlag(flags, "message-id", "tiny-agent im run-ack requires --message-id");
  await service.ackRunChannel({
    stateRoot,
    runId,
    peer,
    messageId,
  });
  output({ runId, peer, messageId }, json);
}

async function cmdListen(
  service: PublicImService,
  stateRoot: string,
  flags: Record<string, string>,
  json: boolean,
): Promise<void> {
  const as = requiredFlag(flags, "as", "tiny-agent im listen requires --as");
  const withEndpoint = requiredFlag(flags, "with", "tiny-agent im listen requires --with");
  let cursor = flags.cursor;

  if (!json) {
    process.stdout.write(`[im] Listening as ${as} with ${withEndpoint}\n`);
    process.stdout.write("[im] Press Ctrl+C to stop\n");
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
      die(`tiny-agent im listen cursor was not found: ${cursor}`, "IM_CURSOR_NOT_FOUND");
    }

    for (const message of result.messages) {
      if (json) {
        process.stdout.write(`${JSON.stringify(message)}\n`);
      } else {
        process.stdout.write(`[${message.createdAt}] ${message.from}: ${message.text}\n`);
      }
    }

    if (result.nextCursor) {
      cursor = result.nextCursor;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
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
