import * as fs from "node:fs";
import * as path from "node:path";
import {
  formatReceiverAckMarker,
  formatReceiverDoneMarker,
} from "../application/managed-shell.js";
import { ImCliTransport } from "../im/transport.js";
import { ReceiverStore, type ReceiverTarget } from "../receiver/index.js";

type ParsedArgs = {
  positional: string[];
  flags: Map<string, string | true>;
};

type ReceiverCliOptions = {
  stdin?: AsyncIterable<string | Uint8Array>;
  stdout?: ReceiverOutput;
};

type ReceiverOutput = {
  write(chunk: string): unknown;
};

type ReceiverEnd = {
  frames: number;
  bytes: number;
  sha256?: string;
};

const RECEIVER_END_MARKER = "__TAH_RECEIVER_END__";

export class ReceiverCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReceiverCliError";
  }
}

export async function runReceiver(
  argv: string[],
  options: ReceiverCliOptions = {},
): Promise<void> {
  const parsed = parseArgs(argv);
  const subcommand = parsed.positional[0];
  const stateDir = flagValue(parsed, "state-dir");
  const baseStateDir = path.resolve(stateDir ?? ".tiny-agent");
  const json = hasFlag(parsed, "json");
  const stdout = options.stdout ?? process.stdout;
  const store = new ReceiverStore({
    rootDir: path.join(baseStateDir, "receiver"),
  });

  if (subcommand === "start") {
    if (json) {
      throw new ReceiverCliError("receiver start is a PTY stdin protocol; --json is not supported");
    }

    const result = store.start({
      receiverId: flagValue(parsed, "id"),
      promptNonce: requiredFlag(parsed, "nonce"),
      commandLine: flagValue(parsed, "command-line") ?? "tiny-agent receiver start",
      mode: parseMode(flagValue(parsed, "mode")),
      maxFrameBytes: parsePositiveInteger(
        requiredFlag(parsed, "max-frame-bytes"),
        "max-frame-bytes",
      ),
      expectedSha256: flagValue(parsed, "sha256"),
      target: parseTarget(parsed),
    });

    writeMarker(result.readyMarker, stdout);
    await receiveFromStdin({
      store,
      baseStateDir,
      receiverId: result.state.receiverId,
      input: options.stdin ?? process.stdin,
      stdout,
    });
    return;
  }

  throw new ReceiverCliError(
    "Usage:\n" +
      "  receiver start --target file --path <path> --nonce <n> --max-frame-bytes <n> [--id <id>] [--sha256 <hash>]\n" +
      "  receiver start --target im --channel <ch> --kind <status|error> --nonce <n> --max-frame-bytes <n> [--run-id <id>]\n\n" +
      `After start, write one base64 frame per stdin line, then write ${RECEIVER_END_MARKER} frames=<n> bytes=<n> [sha256=<hash>].`,
  );
}

async function receiveFromStdin(input: {
  store: ReceiverStore;
  baseStateDir: string;
  receiverId: string;
  input: AsyncIterable<string | Uint8Array>;
  stdout: ReceiverOutput;
}): Promise<void> {
  const tty = asRawModeInput(input.input);
  const restoreRawMode = enableRawMode(tty);
  let buffer = "";

  try {
    for await (const chunk of input.input) {
      buffer += chunkToString(chunk);
      const lines = splitInputLines(buffer);
      buffer = lines.pending;

      for (const line of lines.completeLines) {
        if (line.length === 0) {
          continue;
        }

        const end = parseReceiverEndLine(line);
        if (end !== undefined) {
          await finalizeReceiver({
            store: input.store,
            baseStateDir: input.baseStateDir,
            receiverId: input.receiverId,
            end,
            stdout: input.stdout,
          });
          return;
        }

        const state = input.store.readState(input.receiverId);
        if (state.mode !== "base64") {
          throw new ReceiverCliError(`unsupported receiver stdin mode: ${state.mode}`);
        }
        const seq = state.nextSeq;
        const next = input.store.appendFrame({
          receiverId: input.receiverId,
          seq,
          dataBase64: line,
        });
        const ackMarker = formatReceiverAckMarker({
          nonce: next.promptNonce,
          receiverId: next.receiverId,
          seq,
          bytes: next.bytesReceived,
        });

        writeMarker(ackMarker, input.stdout);
      }
    }

    if (buffer.length > 0) {
      throw new ReceiverCliError("receiver stdin ended with a partial line");
    }
  } finally {
    restoreRawMode();
  }

  throw new ReceiverCliError(`receiver stdin ended before ${RECEIVER_END_MARKER}`);
}

async function finalizeReceiver(input: {
  store: ReceiverStore;
  baseStateDir: string;
  receiverId: string;
  end: ReceiverEnd;
  stdout: ReceiverOutput;
}): Promise<void> {
  const finalized = input.store.finalize({
    receiverId: input.receiverId,
    frames: input.end.frames,
    bytes: input.end.bytes,
    sha256: input.end.sha256,
  });
  await commitTarget(finalized, input.baseStateDir);
  const doneMarker = formatReceiverDoneMarker({
    nonce: finalized.state.promptNonce,
    receiverId: finalized.state.receiverId,
    bytes: finalized.bytes.byteLength,
    sha256: finalized.sha256,
  });

  writeMarker(doneMarker, input.stdout);
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }

    const name = arg.slice(2);
    if (name.length === 0) {
      throw new ReceiverCliError("empty flag name");
    }

    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(name, next);
      i++;
    } else {
      flags.set(name, true);
    }
  }

  return { positional, flags };
}

function parseReceiverEndLine(line: string): ReceiverEnd | undefined {
  if (!line.startsWith(RECEIVER_END_MARKER)) {
    return undefined;
  }

  const fields = parseLineFields(line.slice(RECEIVER_END_MARKER.length).trim());
  return {
    frames: parseNonNegativeInteger(requiredField(fields, "frames"), "frames"),
    bytes: parseNonNegativeInteger(requiredField(fields, "bytes"), "bytes"),
    sha256: optionalField(fields, "sha256"),
  };
}

function parseLineFields(value: string): Map<string, string> {
  const fields = new Map<string, string>();
  if (value.length === 0) {
    return fields;
  }

  for (const token of value.split(/\s+/u)) {
    const equalsIndex = token.indexOf("=");
    if (equalsIndex <= 0) {
      throw new ReceiverCliError(`invalid receiver end token: ${token}`);
    }
    fields.set(token.slice(0, equalsIndex), token.slice(equalsIndex + 1));
  }
  return fields;
}

function requiredField(fields: Map<string, string>, name: string): string {
  const value = fields.get(name);
  if (value === undefined || value.length === 0) {
    throw new ReceiverCliError(`${RECEIVER_END_MARKER} requires ${name}=...`);
  }
  return value;
}

function optionalField(fields: Map<string, string>, name: string): string | undefined {
  const value = fields.get(name);
  return value === undefined || value.length === 0 ? undefined : value;
}

function chunkToString(chunk: string | Uint8Array): string {
  return typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
}

function splitInputLines(value: string): {
  completeLines: string[];
  pending: string;
} {
  const normalized = value.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
  const lines = normalized.split("\n");
  if (!normalized.endsWith("\n")) {
    return {
      completeLines: lines.slice(0, -1),
      pending: lines.at(-1) ?? "",
    };
  }

  return {
    completeLines: lines.slice(0, -1),
    pending: "",
  };
}

type RawModeInput = {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => void;
};

function asRawModeInput(input: AsyncIterable<string | Uint8Array>): RawModeInput {
  return input as RawModeInput;
}

function enableRawMode(input: RawModeInput): () => void {
  if (input.isTTY !== true || typeof input.setRawMode !== "function") {
    return () => {};
  }

  const wasRaw = input.isRaw === true;
  input.setRawMode(true);
  return () => {
    input.setRawMode?.(wasRaw);
  };
}

function parseTarget(parsed: ParsedArgs): ReceiverTarget {
  const target = requiredFlag(parsed, "target");
  if (target === "file") {
    return { kind: "file", path: requiredFlag(parsed, "path") };
  }

  if (target === "im") {
    return {
      kind: "im",
      channel: requiredFlag(parsed, "channel"),
      messageKind: parseMessageKind(requiredFlag(parsed, "kind")),
      runId: flagValue(parsed, "run-id"),
    };
  }

  throw new ReceiverCliError(`unsupported receiver target: ${target}`);
}

function parseMode(value: string | undefined): "base64" | "text" | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "base64" || value === "text") {
    return value;
  }
  throw new ReceiverCliError(`invalid receiver mode: ${value}`);
}

function parseMessageKind(value: string): "status" | "error" {
  if (value === "status" || value === "error") {
    return value;
  }
  throw new ReceiverCliError(`invalid IM message kind: ${value}`);
}

function hasFlag(parsed: ParsedArgs, name: string): boolean {
  return parsed.flags.has(name);
}

function flagValue(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags.get(name);
  if (value === undefined) {
    return undefined;
  }
  if (value === true) {
    throw new ReceiverCliError(`--${name} requires a value`);
  }
  return value;
}

function requiredFlag(parsed: ParsedArgs, name: string): string {
  const value = flagValue(parsed, name);
  if (value === undefined || value.length === 0) {
    throw new ReceiverCliError(`receiver requires --${name}`);
  }
  return value;
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = parseNonNegativeInteger(value, name);
  if (parsed <= 0) {
    throw new ReceiverCliError(`--${name} must be greater than 0`);
  }
  return parsed;
}

function parseNonNegativeInteger(value: string, name: string): number {
  if (!/^\d+$/u.test(value)) {
    throw new ReceiverCliError(`--${name} must be a non-negative integer`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) {
    throw new ReceiverCliError(`--${name} is too large`);
  }
  return parsed;
}

function resolveTargetPath(targetPath: string): string {
  return path.isAbsolute(targetPath) ? targetPath : path.resolve(targetPath);
}

async function commitTarget(
  finalized: ReturnType<ReceiverStore["finalize"]>,
  baseStateDir: string,
): Promise<Record<string, unknown>> {
  const target = finalized.state.target;
  if (target.kind === "file") {
    const destinationPath = resolveTargetPath(target.path);
    atomicWriteBytes(destinationPath, finalized.bytes);
    return { destinationPath };
  }

  const transport = new ImCliTransport({ baseDir: path.join(baseStateDir, "im") });
  await transport.send({
    channel: target.channel,
    role: "agent",
    kind: target.messageKind,
    text: finalized.bytes.toString("utf8"),
    runId: target.runId,
    createdAt: new Date().toISOString(),
    metadata: {
      receiverId: finalized.state.receiverId,
      sha256: finalized.sha256,
      bytes: String(finalized.bytes.byteLength),
    },
  });
  return {
    channel: target.channel,
    kind: target.messageKind,
    runId: target.runId,
  };
}

function atomicWriteBytes(filePath: string, bytes: Buffer): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, bytes);
  fs.renameSync(tempPath, filePath);
}

function writeMarker(marker: string, stdout: ReceiverOutput): void {
  stdout.write(`${marker}\n`);
}
