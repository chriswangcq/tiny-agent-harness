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

export class ReceiverCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReceiverCliError";
  }
}

export async function runReceiver(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv);
  const subcommand = parsed.positional[0];
  const stateDir = flagValue(parsed, "state-dir");
  const baseStateDir = path.resolve(stateDir ?? ".tiny-agent");
  const json = hasFlag(parsed, "json");
  const store = new ReceiverStore({
    rootDir: path.join(baseStateDir, "receiver"),
  });

  if (subcommand === "start") {
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

    writeOutput(
      {
        ok: true,
        receiverId: result.state.receiverId,
        mode: result.state.mode,
        maxFrameBytes: result.state.maxFrameBytes,
        nextSeq: result.state.nextSeq,
        bytesReceived: result.state.bytesReceived,
        target: result.state.target,
        readyMarker: result.readyMarker,
      },
      json,
      result.readyMarker,
    );
    return;
  }

  if (subcommand === "frame") {
    const receiverId = requiredFlag(parsed, "id");
    const seq = parseNonNegativeInteger(requiredFlag(parsed, "seq"), "seq");
    const state = store.appendFrame({
      receiverId,
      seq,
      dataBase64: requiredFlag(parsed, "data-base64"),
    });
    const ackMarker = formatReceiverAckMarker({
      nonce: state.promptNonce,
      receiverId: state.receiverId,
      seq,
      bytes: state.bytesReceived,
    });

    writeOutput(
      {
        ok: true,
        receiverId: state.receiverId,
        seq,
        nextSeq: state.nextSeq,
        bytesReceived: state.bytesReceived,
        ackMarker,
      },
      json,
      ackMarker,
    );
    return;
  }

  if (subcommand === "end") {
    const finalized = store.finalize({
      receiverId: requiredFlag(parsed, "id"),
      frames: parseNonNegativeInteger(requiredFlag(parsed, "frames"), "frames"),
      bytes: parseNonNegativeInteger(requiredFlag(parsed, "bytes"), "bytes"),
      sha256: requiredFlag(parsed, "sha256"),
    });
    const commit = await commitTarget(finalized, baseStateDir);
    const doneMarker = formatReceiverDoneMarker({
      nonce: finalized.state.promptNonce,
      receiverId: finalized.state.receiverId,
      bytes: finalized.bytes.byteLength,
      sha256: finalized.sha256,
    });

    writeOutput(
      {
        ok: true,
        receiverId: finalized.state.receiverId,
        target: finalized.state.target,
        ...commit,
        bytes: finalized.bytes.byteLength,
        sha256: finalized.sha256,
        doneMarker,
      },
      json,
      doneMarker,
    );
    return;
  }

  throw new ReceiverCliError(
    "Usage:\n" +
      "  receiver start --target file --path <path> --nonce <n> --max-frame-bytes <n> [--id <id>] [--sha256 <hash>] [--json]\n" +
      "  receiver start --target im --channel <ch> --kind <status|error> --nonce <n> --max-frame-bytes <n> [--run-id <id>] [--json]\n" +
      "  receiver frame --id <id> --seq <n> --data-base64 <b64> [--json]\n" +
      "  receiver end --id <id> --frames <n> --bytes <n> --sha256 <hash> [--json]",
  );
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

function writeOutput(
  value: Record<string, unknown>,
  json: boolean,
  marker: string,
): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${marker}\n`);
}
