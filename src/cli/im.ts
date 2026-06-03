import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { ImCliTransport } from "../im/transport.js";

type StdinSource = AsyncIterable<string | Buffer | Uint8Array>;

function die(message: string, errorCode = "IM_ERROR"): never {
  process.stderr.write(JSON.stringify({ ok: false, errorCode, error: message }) + "\n");
  process.exit(1);
}

const RESERVED_POST_SENDERS = new Set(["agent", "assistant", "system", "tool"]);

type ImTarget = {
  baseDir: string;
  runId?: string;
  target: "explicit_state" | "env_im_dir" | "global_state" | "run";
};

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

export async function runIm(
  argv: string[],
  options: { stdin?: StdinSource } = {},
): Promise<void> {
  const subcommand = argv[0];
  const rest = argv.slice(1);
  const jsonMode = hasFlag(rest, "json");
  const textStdin = hasFlag(rest, "text-stdin");
  const { flags } = parseArgs(rest.filter((a) => a !== "--json" && a !== "--text-stdin"));

  if (!isImSubcommand(subcommand)) {
    die(imUsage());
  }

  const target = resolveImTarget(flags);
  const transport = new ImCliTransport({ baseDir: target.baseDir });

  switch (subcommand) {
    case "post":
      await cmdPost(transport, flags, jsonMode, target);
      break;
    case "recv":
      await cmdRecv(transport, flags, jsonMode);
      break;
    case "send":
      await cmdSend(
        transport,
        flags,
        jsonMode,
        textStdin,
        options.stdin ?? (process.stdin as unknown as StdinSource),
      );
      break;
    case "ack":
      await cmdAck(transport, flags, jsonMode);
      break;
    case "listen":
      await cmdListen(transport, flags, jsonMode);
      break;
    default:
      subcommand satisfies never;
  }
}

function isImSubcommand(value: string | undefined): value is
  | "post"
  | "recv"
  | "send"
  | "ack"
  | "listen" {
  return (
    value === "post" ||
    value === "recv" ||
    value === "send" ||
    value === "ack" ||
    value === "listen"
  );
}

function imUsage(): string {
  return (
    "Usage: im <post|recv|send|ack|listen> [options]\n" +
    "  im post --channel <ch> --text <text> [--from <user-label>] [--run <runId|latest>] [--json]\n" +
    "  im recv --channel <ch> [--cursor <cursor>] [--json]\n" +
    "  im send --channel <ch> --kind <status|error> (--text <text>|--text-stdin) [--run-id <id>] [--json]\n" +
    "  im ack --channel <ch> --message-id <id> [--json]\n" +
    "  im listen --channel <ch> [--cursor <cursor>] [--json]"
  );
}

function resolveImTarget(flags: Record<string, string>): ImTarget {
  const explicitStateDir = flags["state-dir"];
  const run = flags["run"];
  const stateDir = path.resolve(
    explicitStateDir ?? process.env.TAH_STATE_DIR ?? ".tiny-agent",
  );

  if (run) {
    const runId = resolveRunId(stateDir, run);
    return {
      baseDir: path.join(stateDir, "runs", runId, "im"),
      runId,
      target: "run",
    };
  }

  if (explicitStateDir) {
    return {
      baseDir: path.join(explicitStateDir, "im"),
      target: "explicit_state",
    };
  }

  if (process.env.TAH_IM_DIR) {
    return {
      baseDir: process.env.TAH_IM_DIR,
      target: "env_im_dir",
    };
  }

  const latestRunId = readLatestRunId(stateDir);
  if (latestRunId) {
    return {
      baseDir: path.join(stateDir, "runs", latestRunId, "im"),
      runId: latestRunId,
      target: "run",
    };
  }

  return {
    baseDir: path.join(stateDir, "im"),
    target: "global_state",
  };
}

function resolveRunId(stateDir: string, run: string): string {
  if (run !== "latest") {
    return run;
  }
  const latestRunId = readLatestRunId(stateDir);
  if (!latestRunId) {
    die(`No latest run found under ${path.join(stateDir, "runs")}`);
  }
  return latestRunId;
}

function readLatestRunId(stateDir: string): string | undefined {
  const latestPath = path.join(stateDir, "runs", "latest.json");
  if (!fs.existsSync(latestPath)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(latestPath, "utf-8")) as {
      runId?: unknown;
    };
    return typeof parsed.runId === "string" && parsed.runId.length > 0
      ? parsed.runId
      : undefined;
  } catch {
    return undefined;
  }
}

async function cmdPost(
  transport: ImCliTransport,
  flags: Record<string, string>,
  json: boolean,
  target: ImTarget,
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

  output({ ok: true, id, channel, target: target.target, runId: target.runId }, json);
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
  textStdin: boolean,
  stdin: StdinSource,
): Promise<void> {
  const rawChannel = flags["channel"];
  // Auto-correct channel to match bound run channel (prevents IM channel drift)
  const boundChannel = process.env.TAH_RUN_CHANNEL;
  const channel = (boundChannel && rawChannel !== boundChannel) ? boundChannel : rawChannel;
  const kind = flags["kind"] as "status" | "error" | undefined;
  if (flags["text"] !== undefined && textStdin) {
    die("im send accepts either --text or --text-stdin, not both");
  }
  const text = flags["text"] ?? (textStdin ? await readStdinText(stdin) : undefined);
  if (!channel || !kind || text === undefined || text.length === 0) {
    die("im send requires --channel, --kind, and --text or --text-stdin");
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

async function readStdinText(stdin: StdinSource): Promise<string> {
  let text = "";
  for await (const chunk of stdin) {
    text += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
  }
  return text;
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
