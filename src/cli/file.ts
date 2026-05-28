import * as path from "node:path";

import { StashFileStore } from "../stash/file-store.js";

function die(message: string): never {
  console.error(`[tiny-agent] ERROR: ${message}`);
  process.exit(1);
}

function extractSharedFlags(args: string[]): {
  rest: string[];
  stateDir?: string;
  json: boolean;
} {
  const rest: string[] = [];
  let stateDir: string | undefined;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--state-dir" && i + 1 < args.length) {
      stateDir = args[++i];
    } else if (arg === "--json") {
      json = true;
    } else {
      rest.push(arg);
    }
  }

  return { rest, stateDir, json };
}

function createStore(stateDir?: string): StashFileStore {
  const baseDir = path.resolve(stateDir ?? ".tiny-agent");
  return new StashFileStore({
    rootDir: path.join(baseDir, "stash", "files"),
    cwd: process.cwd(),
  });
}

export async function runFile(args: string[]): Promise<void> {
  const { rest, stateDir, json } = extractSharedFlags(args);
  const subcommand = rest[0];
  const store = createStore(stateDir);

  if (subcommand === "list") {
    const items = store.list();
    if (json) {
      process.stdout.write(`${JSON.stringify(items, null, 2)}\n`);
      return;
    }
    if (items.length === 0) {
      console.log("[tiny-agent] No stashed files.");
      return;
    }
    for (const item of items) {
      console.log(
        `${item.stashId}\t${item.bytes} bytes\t${item.sha256}\t${item.name}`,
      );
    }
    return;
  }

  if (subcommand === "show") {
    const stashId = rest[1];
    if (!stashId) {
      die("Usage: tiny-agent file show <stashId> [--json] [--state-dir <dir>]");
    }
    const meta = store.readMeta(stashId);
    if (json) {
      process.stdout.write(`${JSON.stringify(meta, null, 2)}\n`);
      return;
    }
    console.log(`stashId:     ${meta.stashId}`);
    console.log(`name:        ${meta.name}`);
    console.log(`bytes:       ${meta.bytes}`);
    console.log(`sha256:      ${meta.sha256}`);
    console.log(`createdAt:   ${meta.createdAt}`);
    console.log(`toolCallId:  ${meta.toolCallId}`);
    if (meta.description) {
      console.log(`description: ${meta.description}`);
    }
    return;
  }

  if (subcommand === "materialize") {
    const stashId = rest[1];
    const destination = rest[2];
    if (!stashId || !destination) {
      die(
        "Usage: tiny-agent file materialize <stashId> <path> [--json] [--state-dir <dir>]",
      );
    }
    const result = store.materialize(stashId, destination);
    if (json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    console.log(
      `[tiny-agent] Materialized ${result.stashId} to ${result.destinationPath} ` +
        `(${result.bytes} bytes, sha256 ${result.sha256}).`,
    );
    return;
  }

  die(
    "Usage:\n" +
      "  tiny-agent file list [--json] [--state-dir <dir>]\n" +
      "  tiny-agent file show <stashId> [--json] [--state-dir <dir>]\n" +
      "  tiny-agent file materialize <stashId> <path> [--json] [--state-dir <dir>]",
  );
}
