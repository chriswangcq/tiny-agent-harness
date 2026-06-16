import * as fs from "node:fs";
import * as path from "node:path";
import {
  createRunImSelfEndpoint,
  DEFAULT_RUN_USER_ENDPOINT,
} from "./run-endpoints.js";
import { planImChannelLayout, planImCursorLayout } from "./layout.js";
import {
  createNodeImStore,
  readJsonlFile,
  type ImStorePort,
} from "./store.js";
import {
  PublicImService as DefaultPublicImService,
  type PublicImImportedMessage,
  type PublicImMessage,
  type PublicImMessageKind,
  type PublicImService,
} from "./service.js";

export type LegacyRunImMigrationInput = {
  stateRoot: string;
  runIds?: readonly string[];
  userEndpoint?: string;
  dryRun?: boolean;
  service?: PublicImService;
  store?: ImStorePort;
  nowIso?: () => string;
};

export type LegacyRunImMigrationRunResult = {
  runId: string;
  runDir: string;
  hadBinding: boolean;
  bound: boolean;
  legacyInboxCount: number;
  legacyOutboxCount: number;
  importedInboxCount: number;
  importedOutboxCount: number;
  duplicateInboxCount: number;
  duplicateOutboxCount: number;
  cursorAlreadyPresent: boolean;
  cursorSetTo?: string;
  wouldSetCursorTo?: string;
};

export type LegacyRunImMigrationSummary = {
  stateRoot: string;
  dryRun: boolean;
  runsScanned: number;
  runsChanged: number;
  importedMessages: number;
  duplicateMessages: number;
  cursorsSet: number;
  runs: LegacyRunImMigrationRunResult[];
};

type LegacyImRecord = {
  id?: unknown;
  role?: unknown;
  kind?: unknown;
  channel?: unknown;
  text?: unknown;
  createdAt?: unknown;
};

export async function migrateLegacyRunIm(
  input: LegacyRunImMigrationInput,
): Promise<LegacyRunImMigrationSummary> {
  const stateRoot = path.resolve(input.stateRoot);
  const userEndpoint = input.userEndpoint ?? DEFAULT_RUN_USER_ENDPOINT;
  const dryRun = input.dryRun ?? false;
  const store = input.store ?? createNodeImStore();
  const service =
    input.service ??
    new DefaultPublicImService({
      store,
      clock: { nowIso: input.nowIso ?? (() => new Date().toISOString()) },
      ids: {
        newMessageId: () => {
          throw new Error("legacy IM migration imports explicit message ids");
        },
      },
    });
  const runIds = await discoverRunIds(stateRoot, input.runIds);
  const runs: LegacyRunImMigrationRunResult[] = [];

  for (const runId of runIds) {
    runs.push(
      await migrateOneRun({
        stateRoot,
        runId,
        userEndpoint,
        dryRun,
        service,
        store,
      }),
    );
  }

  const importedMessages = runs.reduce(
    (sum, run) => sum + run.importedInboxCount + run.importedOutboxCount,
    0,
  );
  const duplicateMessages = runs.reduce(
    (sum, run) => sum + run.duplicateInboxCount + run.duplicateOutboxCount,
    0,
  );
  const cursorsSet = runs.filter((run) => run.cursorSetTo !== undefined).length;
  const runsChanged = runs.filter(
    (run) =>
      run.bound ||
      run.importedInboxCount > 0 ||
      run.importedOutboxCount > 0 ||
      run.cursorSetTo !== undefined,
  ).length;

  return {
    stateRoot,
    dryRun,
    runsScanned: runs.length,
    runsChanged,
    importedMessages,
    duplicateMessages,
    cursorsSet,
    runs,
  };
}

export async function runLegacyRunImMigrationCli(
  argv: readonly string[],
  deps: {
    stdout?: { write(text: string): unknown };
    stderr?: { write(text: string): unknown };
  } = {},
): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  try {
    const options = parseLegacyMigrationArgs(argv);
    const summary = await migrateLegacyRunIm(options);
    if (options.json) {
      stdout.write(`${JSON.stringify(summary)}\n`);
    } else {
      stdout.write(formatLegacyMigrationSummary(summary));
    }
    return 0;
  } catch (error) {
    stderr.write(
      `[legacy-im-migration] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

async function migrateOneRun(input: {
  stateRoot: string;
  runId: string;
  userEndpoint: string;
  dryRun: boolean;
  service: PublicImService;
  store: ImStorePort;
}): Promise<LegacyRunImMigrationRunResult> {
  const runDir = path.join(input.stateRoot, "runs", input.runId);
  const selfEndpoint = createRunImSelfEndpoint(input.runId);
  const inboxPath = path.join(runDir, "im", "default.inbox.jsonl");
  const outboxPath = path.join(runDir, "im", "default.outbox.jsonl");
  const hadBinding = await hasRunBinding(input.service, input.stateRoot, input.runId);
  const cursorPath = planImCursorLayout(
    input.stateRoot,
    input.userEndpoint,
    selfEndpoint,
    selfEndpoint,
  ).cursorFile;
  const cursorAlreadyPresent =
    ((await input.store.readText(cursorPath))?.trim().length ?? 0) > 0;
  const inboxMessages = await readLegacyMessages(inboxPath, {
    runId: input.runId,
    from: input.userEndpoint,
    to: selfEndpoint,
    direction: "inbox",
  });
  const outboxMessages = await readLegacyMessages(outboxPath, {
    runId: input.runId,
    from: selfEndpoint,
    to: input.userEndpoint,
    direction: "outbox",
  });
  const lastLegacyInbox = inboxMessages
    .slice()
    .sort(compareImportedMessagesByTimeAndId)
    .at(-1);

  if (input.dryRun) {
    const duplicateInboxCount = await countExistingMessageIds({
      stateRoot: input.stateRoot,
      store: input.store,
      from: input.userEndpoint,
      to: selfEndpoint,
      messages: inboxMessages,
    });
    const duplicateOutboxCount = await countExistingMessageIds({
      stateRoot: input.stateRoot,
      store: input.store,
      from: selfEndpoint,
      to: input.userEndpoint,
      messages: outboxMessages,
    });
    return {
      runId: input.runId,
      runDir,
      hadBinding,
      bound: !hadBinding,
      legacyInboxCount: inboxMessages.length,
      legacyOutboxCount: outboxMessages.length,
      importedInboxCount: inboxMessages.length - duplicateInboxCount,
      importedOutboxCount: outboxMessages.length - duplicateOutboxCount,
      duplicateInboxCount,
      duplicateOutboxCount,
      cursorAlreadyPresent,
      ...(cursorAlreadyPresent || !lastLegacyInbox
        ? {}
        : { wouldSetCursorTo: lastLegacyInbox.id }),
    };
  }

  await input.service.bindRun({
    stateRoot: input.stateRoot,
    runId: input.runId,
    self: selfEndpoint,
    peer: input.userEndpoint,
    kind: "a2user",
  });

  const inboxImport = await input.service.importMessages({
    stateRoot: input.stateRoot,
    from: input.userEndpoint,
    to: selfEndpoint,
    messages: inboxMessages,
  });
  const outboxImport = await input.service.importMessages({
    stateRoot: input.stateRoot,
    from: selfEndpoint,
    to: input.userEndpoint,
    messages: outboxMessages,
  });

  let cursorSetTo: string | undefined;
  if (!cursorAlreadyPresent && lastLegacyInbox) {
    await input.service.ackRunChannel({
      stateRoot: input.stateRoot,
      runId: input.runId,
      peer: input.userEndpoint,
      messageId: lastLegacyInbox.id,
    });
    cursorSetTo = lastLegacyInbox.id;
  }

  return {
    runId: input.runId,
    runDir,
    hadBinding,
    bound: !hadBinding,
    legacyInboxCount: inboxMessages.length,
    legacyOutboxCount: outboxMessages.length,
    importedInboxCount: inboxImport.importedCount,
    importedOutboxCount: outboxImport.importedCount,
    duplicateInboxCount: inboxImport.duplicateCount,
    duplicateOutboxCount: outboxImport.duplicateCount,
    cursorAlreadyPresent,
    ...(cursorSetTo ? { cursorSetTo } : {}),
  };
}

async function countExistingMessageIds(input: {
  stateRoot: string;
  store: ImStorePort;
  from: string;
  to: string;
  messages: readonly PublicImImportedMessage[];
}): Promise<number> {
  if (input.messages.length === 0) {
    return 0;
  }
  const layout = planImChannelLayout(input.stateRoot, input.from, input.to);
  const existing = await readJsonlFile<PublicImMessage>(
    input.store,
    layout.messagesFile,
  );
  const existingIds = new Set(existing.map((message) => message.id));
  return input.messages.filter((message) => existingIds.has(message.id)).length;
}

async function discoverRunIds(
  stateRoot: string,
  explicitRunIds: readonly string[] | undefined,
): Promise<string[]> {
  if (explicitRunIds && explicitRunIds.length > 0) {
    return [...new Set(explicitRunIds)].sort();
  }
  const runsDir = path.join(stateRoot, "runs");
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(runsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`State root has no runs directory: ${runsDir}`);
    }
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("run-"))
    .map((entry) => entry.name)
    .sort();
}

async function hasRunBinding(
  service: PublicImService,
  stateRoot: string,
  runId: string,
): Promise<boolean> {
  try {
    await service.readRunBinding(stateRoot, runId);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes(`IM run binding not found for ${runId}`)
    ) {
      return false;
    }
    throw error;
  }
}

async function readLegacyMessages(
  filePath: string,
  context: {
    runId: string;
    from: string;
    to: string;
    direction: "inbox" | "outbox";
  },
): Promise<PublicImImportedMessage[]> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(filePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  return raw
    .split("\n")
    .map((line, index) => ({ line, lineNumber: index + 1 }))
    .filter(({ line }) => line.trim().length > 0)
    .map(({ line, lineNumber }) =>
      normalizeLegacyRecord(parseLegacyRecord(filePath, lineNumber, line), {
        ...context,
        filePath,
        lineNumber,
      }),
    );
}

function parseLegacyRecord(
  filePath: string,
  lineNumber: number,
  line: string,
): LegacyImRecord {
  try {
    return JSON.parse(line) as LegacyImRecord;
  } catch (error) {
    throw new Error(
      `Invalid legacy IM JSON at ${filePath}:${lineNumber}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function normalizeLegacyRecord(
  record: LegacyImRecord,
  context: {
    runId: string;
    from: string;
    to: string;
    direction: "inbox" | "outbox";
    filePath: string;
    lineNumber: number;
  },
): PublicImImportedMessage {
  const id = requireString(record.id, "id", context);
  const text = requireString(record.text, "text", context);
  const createdAt = requireString(record.createdAt, "createdAt", context);
  const channel = typeof record.channel === "string" ? record.channel : undefined;
  const kind = normalizeLegacyKind(record.kind, context.direction);
  const expectedRole = context.direction === "inbox" ? "user" : "agent";
  if (record.role !== undefined && record.role !== expectedRole) {
    throw new Error(
      `Invalid legacy IM role at ${context.filePath}:${context.lineNumber}: expected ${expectedRole}`,
    );
  }
  return {
    id,
    role: expectedRole,
    kind,
    text,
    createdAt,
    metadata: {
      source: "legacy-run-im",
      legacyRunId: context.runId,
      legacyDirection: context.direction,
      legacyChannel: channel ?? "default",
      legacyFile: path.basename(context.filePath),
    },
  };
}

function normalizeLegacyKind(
  value: unknown,
  direction: "inbox" | "outbox",
): PublicImMessageKind {
  if (direction === "inbox") {
    return "message";
  }
  return value === "error" ? "error" : "status";
}

function requireString(
  value: unknown,
  field: string,
  context: { filePath: string; lineNumber: number },
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `Invalid legacy IM record at ${context.filePath}:${context.lineNumber}: ${field} must be a non-empty string`,
    );
  }
  return value;
}

function compareImportedMessagesByTimeAndId(
  left: PublicImImportedMessage,
  right: PublicImImportedMessage,
): number {
  const byTime = left.createdAt.localeCompare(right.createdAt);
  return byTime !== 0 ? byTime : left.id.localeCompare(right.id);
}

function parseLegacyMigrationArgs(argv: readonly string[]): LegacyRunImMigrationInput & {
  json: boolean;
} {
  let stateRoot: string | undefined;
  let dryRun = false;
  let json = false;
  const runIds: string[] = [];
  let userEndpoint: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--state-dir" && argv[index + 1] && !argv[index + 1]!.startsWith("--")) {
      stateRoot = argv[++index];
    } else if (arg === "--run-id" && argv[index + 1] && !argv[index + 1]!.startsWith("--")) {
      runIds.push(argv[++index]!);
    } else if (arg === "--user-endpoint" && argv[index + 1] && !argv[index + 1]!.startsWith("--")) {
      userEndpoint = argv[++index];
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--help" || arg === "-h") {
      throw new Error(legacyMigrationUsage());
    } else {
      throw new Error(`Unknown legacy IM migration argument: ${arg}\n${legacyMigrationUsage()}`);
    }
  }

  if (!stateRoot) {
    throw new Error(`Missing --state-dir <dir>\n${legacyMigrationUsage()}`);
  }
  return {
    stateRoot,
    dryRun,
    json,
    ...(runIds.length > 0 ? { runIds } : {}),
    ...(userEndpoint ? { userEndpoint } : {}),
  };
}

function formatLegacyMigrationSummary(summary: LegacyRunImMigrationSummary): string {
  const lines = [
    `[legacy-im-migration] stateRoot=${summary.stateRoot}`,
    `[legacy-im-migration] dryRun=${summary.dryRun}`,
    `[legacy-im-migration] runsScanned=${summary.runsScanned} runsChanged=${summary.runsChanged} importedMessages=${summary.importedMessages} duplicateMessages=${summary.duplicateMessages} cursorsSet=${summary.cursorsSet}`,
  ];
  for (const run of summary.runs) {
    lines.push(
      [
        `[legacy-im-migration] run=${run.runId}`,
        `bound=${run.bound}`,
        `legacyInbox=${run.legacyInboxCount}`,
        `legacyOutbox=${run.legacyOutboxCount}`,
        `importedInbox=${run.importedInboxCount}`,
        `importedOutbox=${run.importedOutboxCount}`,
        `duplicates=${run.duplicateInboxCount + run.duplicateOutboxCount}`,
        `cursor=${run.cursorSetTo ?? run.wouldSetCursorTo ?? (run.cursorAlreadyPresent ? "existing" : "none")}`,
      ].join(" "),
    );
  }
  return `${lines.join("\n")}\n`;
}

function legacyMigrationUsage(): string {
  return [
    "Usage: node scripts/migrate-legacy-runs-to-public-im.mjs --state-dir <project-state-dir> [--dry-run] [--json] [--run-id <runId>...]",
    "",
    "Imports runs/<runId>/im/default.inbox.jsonl and default.outbox.jsonl into project-scoped public IM.",
  ].join("\n");
}
