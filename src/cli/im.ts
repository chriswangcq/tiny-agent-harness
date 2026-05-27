import * as crypto from "node:crypto";
import { ImCliTransport } from "../im/transport.js";

function die(message: string, errorCode = "IM_ERROR"): never {
  process.stderr.write(JSON.stringify({ ok: false, errorCode, error: message }) + "\n");
  process.exit(1);
}

const RESERVED_POST_SENDERS = new Set(["agent", "assistant", "system", "tool"]);

function parseArgs(argv: string[]): { flags: Record<string, string>; positional: string[] } {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--") && i + 1 < argv.length) {
      flags[arg.slice(2)] = argv[++i]!;
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

function output(data: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify(data) + "\n");
  } else {
    const lines = flatten(data);
    for (const line of lines) {
      process.stdout.write(line + "\n");
    }
  }
}

function flatten(data: unknown, prefix = ""): string[] {
  if (data === null || data === undefined) return [];
  if (Array.isArray(data)) {
    return data.flatMap((item, i) => flatten(item, `${prefix}[${i}]`));
  }
  if (typeof data === "object") {
    return Object.entries(data as Record<string, unknown>).flatMap(([k, v]) => {
      const key = prefix ? `${prefix}.${k}` : k;
      if (typeof v === "object" && v !== null) return flatten(v, key);
      return [`${key}=${String(v)}`];
    });
  }
  return [prefix ? `${prefix}=${String(data)}` : String(data)];
}

export async function runIm(argv: string[]): Promise<void> {
  const subcommand = argv[0];
  const rest = argv.slice(1);
  const jsonMode = hasFlag(rest, "json");
  const { flags } = parseArgs(rest.filter((a) => a !== "--json"));

  const stateDir = flags["state-dir"];
  const baseDir = stateDir
    ? `${stateDir}/im`
    : ".tiny-agent/im";

  const transport = new ImCliTransport({ baseDir });

  switch (subcommand) {
    case "post":
      await cmdPost(transport, flags, jsonMode);
      break;
    case "recv":
      await cmdRecv(transport, flags, jsonMode);
      break;
    case "send":
      await cmdSend(transport, flags, jsonMode);
      break;
    case "ack":
      await cmdAck(transport, flags, jsonMode);
      break;
    case "listen":
      await cmdListen(transport, flags, jsonMode);
      break;
    default:
      die(
        "Usage: im <post|recv|send|ack|listen> [options]\n" +
          "  im post --channel <ch> --text <text> [--from <user-label>] [--json]\n" +
          "  im recv --channel <ch> [--cursor <cursor>] [--json]\n" +
          "  im send --channel <ch> --kind <status|error> --text <text> [--run-id <id>] [--json]\n" +
          "  im ack --channel <ch> --message-id <id> [--json]\n" +
          "  im listen --channel <ch> [--cursor <cursor>] [--json]",
      );
  }
}

async function cmdPost(
  transport: ImCliTransport,
  flags: Record<string, string>,
  json: boolean,
): Promise<void> {
  const channel = flags["channel"];
  const text = flags["text"];
  if (!channel || !text) die("im post requires --channel and --text");
  const from = flags["from"];
  if (from && RESERVED_POST_SENDERS.has(from.toLowerCase())) {
    die(
      `im post creates user inbox messages; use im send for agent replies instead of --from ${from}`,
      "IM_POST_RESERVED_SENDER",
    );
  }

  const id = `msg-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  const message = {
    id,
    channel,
    role: "user" as const,
    text,
    createdAt: new Date().toISOString(),
    metadata: from ? { from } : undefined,
  };

  await transport.post(message);

  output({ ok: true, id, channel }, json);
}

async function cmdRecv(
  transport: ImCliTransport,
  flags: Record<string, string>,
  json: boolean,
): Promise<void> {
  const channel = flags["channel"];
  if (!channel) die("im recv requires --channel");

  const cursor = flags["cursor"] ?? transport.readCursorSync(channel);
  const result = await transport.receive({
    channel,
    cursor,
  });
  if (result.cursorFound === false) {
    die(`im recv cursor was not found: ${cursor}`, "IM_CURSOR_NOT_FOUND");
  }

  output(
    {
      ok: true,
      channel,
      count: result.messages.length,
      nextCursor: result.nextCursor,
      messages: result.messages,
    },
    json,
  );
}

async function cmdSend(
  transport: ImCliTransport,
  flags: Record<string, string>,
  json: boolean,
): Promise<void> {
  const channel = flags["channel"];
  const kind = flags["kind"] as "status" | "error" | undefined;
  const text = flags["text"];
  if (!channel || !kind || !text) {
    die("im send requires --channel, --kind, and --text");
  }
  if (!["status", "error"].includes(kind)) {
    die("--kind must be one of: status, error");
  }

  const id = `agent-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  const message = {
    id,
    channel,
    role: "agent" as const,
    kind,
    text,
    runId: flags["run-id"],
    createdAt: new Date().toISOString(),
  };

  await transport.send(message);

  output({ ok: true, id, channel, kind }, json);
}

async function cmdAck(
  transport: ImCliTransport,
  flags: Record<string, string>,
  json: boolean,
): Promise<void> {
  const channel = flags["channel"];
  const messageId = flags["message-id"];
  if (!channel || !messageId) die("im ack requires --channel and --message-id");

  await transport.ack({ channel, messageId });

  output({ ok: true, channel, messageId }, json);
}

async function cmdListen(
  transport: ImCliTransport,
  flags: Record<string, string>,
  json: boolean,
): Promise<void> {
  const channel = flags["channel"];
  if (!channel) die("im listen requires --channel");

  let cursor = flags["cursor"] ?? transport.readCursorSync(channel);

  if (!json) {
    process.stdout.write(`[im] Listening on channel: ${channel}\n`);
    process.stdout.write(`[im] Press Ctrl+C to stop\n`);
  }

  const onExit = () => process.exit(0);
  process.on("SIGINT", onExit);
  process.on("SIGTERM", onExit);

  while (true) {
    const result = await transport.receive({ channel, cursor });
    if (result.cursorFound === false) {
      die(`im listen cursor was not found: ${cursor}`, "IM_CURSOR_NOT_FOUND");
    }

    for (const msg of result.messages) {
      if (json) {
        process.stdout.write(JSON.stringify(msg) + "\n");
      } else {
        process.stdout.write(
          `[${msg.createdAt}] ${msg.role}: ${msg.text}\n`,
        );
      }
    }

    if (result.nextCursor) {
      cursor = result.nextCursor;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
