import * as fs from "node:fs";
import * as path from "node:path";
import { stripManagedShellScreenNoise } from "../terminal/screen-filter.js";
import type { SessionTailUpdate } from "./types.js";

const DEFAULT_MAX_TAIL_BYTES = 64 * 1024;
const DEFAULT_MAX_TAIL_CHARS = 4000;

type CachedLogTail = {
  size: number;
  mtimeMs: number;
  update: SessionTailUpdate;
};

export type SessionLogTailReaderOptions = {
  sessionsDir: string;
  maxTailBytes?: number;
  maxTailChars?: number;
};

export class SessionLogTailReader {
  private readonly sessionsDir: string;
  private readonly maxTailBytes: number;
  private readonly maxTailChars: number;
  private readonly cache = new Map<string, CachedLogTail>();

  constructor(options: SessionLogTailReaderOptions) {
    this.sessionsDir = options.sessionsDir;
    this.maxTailBytes = positiveInteger(options.maxTailBytes) ?? DEFAULT_MAX_TAIL_BYTES;
    this.maxTailChars = positiveInteger(options.maxTailChars) ?? DEFAULT_MAX_TAIL_CHARS;
  }

  read(): SessionTailUpdate[] {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.sessionsDir);
    } catch {
      return [];
    }

    const updates: SessionTailUpdate[] = [];
    for (const entry of entries.sort()) {
      if (!entry.endsWith(".log")) {
        continue;
      }

      const logPath = path.join(this.sessionsDir, entry);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(logPath);
      } catch {
        continue;
      }
      if (!stat.isFile()) {
        continue;
      }

      const cached = this.cache.get(logPath);
      if (
        cached !== undefined &&
        cached.size === stat.size &&
        cached.mtimeMs === stat.mtimeMs
      ) {
        updates.push(cached.update);
        continue;
      }

      const update = readSessionLogTail({
        logPath,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        maxTailBytes: this.maxTailBytes,
        maxTailChars: this.maxTailChars,
      });
      if (update === undefined) {
        continue;
      }
      this.cache.set(logPath, {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        update,
      });
      updates.push(update);
    }

    return updates;
  }
}

function readSessionLogTail(input: {
  logPath: string;
  size: number;
  mtimeMs: number;
  maxTailBytes: number;
  maxTailChars: number;
}): SessionTailUpdate | undefined {
  const readStart = Math.max(0, input.size - input.maxTailBytes - 4);
  const length = input.size - readStart;
  let fd: number | undefined;
  try {
    fd = fs.openSync(input.logPath, "r");
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, readStart);
    let text = buffer.toString("utf-8");
    if (readStart > 0) {
      text = dropFirstPartialLine(text);
    }
    const filtered = stripManagedShellScreenNoise(text).output;
    return {
      session: inferSessionName(input.logPath),
      logPath: input.logPath,
      tail: takeTailChars(filtered, input.maxTailChars),
      tailOffset: input.size,
      updatedAt: new Date(input.mtimeMs).toISOString(),
    };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // best-effort close for display-only tailing
      }
    }
  }
}

function dropFirstPartialLine(text: string): string {
  const newlineIndex = text.search(/\n/u);
  return newlineIndex === -1 ? "" : text.slice(newlineIndex + 1);
}

function inferSessionName(logPath: string): string {
  const basename = path.basename(logPath, ".log");
  const matched = /^(.*)-[a-f0-9]{10}$/u.exec(basename);
  return matched?.[1] || basename;
}

function takeTailChars(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(-maxChars) : text;
}

function positiveInteger(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const integer = Math.floor(value);
  return integer > 0 ? integer : undefined;
}
