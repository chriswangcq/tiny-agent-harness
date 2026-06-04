import * as fs from "node:fs";
import * as path from "node:path";
import { XtermTerminalScreenBuffer } from "../terminal/screen-buffer.js";
import type { SessionTailUpdate } from "./types.js";

const DEFAULT_MAX_REPLAY_BYTES = 256 * 1024;
const DEFAULT_MAX_TAIL_CHARS = 4000;
const DEFAULT_SCREEN_ROWS = 24;
const DEFAULT_SCREEN_COLS = 80;

type CachedLogProjection = {
  size: number;
  mtimeMs: number;
  update: SessionTailUpdate;
  buffer: XtermTerminalScreenBuffer;
};

export type SessionLogTailReaderOptions = {
  sessionsDir: string;
  maxTailBytes?: number;
  maxTailChars?: number;
  screenRows?: number;
  screenCols?: number;
};

export class SessionLogTailReader {
  private readonly sessionsDir: string;
  private readonly maxReplayBytes: number;
  private readonly maxTailChars: number;
  private readonly screenRows: number;
  private readonly screenCols: number;
  private readonly cache = new Map<string, CachedLogProjection>();

  constructor(options: SessionLogTailReaderOptions) {
    this.sessionsDir = options.sessionsDir;
    this.maxReplayBytes =
      positiveInteger(options.maxTailBytes) ?? DEFAULT_MAX_REPLAY_BYTES;
    this.maxTailChars =
      positiveInteger(options.maxTailChars) ?? DEFAULT_MAX_TAIL_CHARS;
    this.screenRows =
      positiveInteger(options.screenRows) ?? DEFAULT_SCREEN_ROWS;
    this.screenCols =
      positiveInteger(options.screenCols) ?? DEFAULT_SCREEN_COLS;
  }

  async read(): Promise<SessionTailUpdate[]> {
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

      const projection =
        cached !== undefined &&
        (stat.size > cached.size ||
          (stat.size === cached.size && stat.mtimeMs === cached.mtimeMs))
          ? cached
          : this.resetProjection(logPath);
      const chunk = readSessionLogChunk({
        logPath,
        size: stat.size,
        startOffset: projection.size,
        maxReplayBytes: this.maxReplayBytes,
      });
      if (chunk === undefined) {
        continue;
      }

      projection.buffer.write(chunk);
      const screen = await projection.buffer.snapshot();
      const update: SessionTailUpdate = {
        session: inferSessionName(logPath),
        logPath,
        tail: takeTailChars(screen.text, this.maxTailChars),
        tailOffset: stat.size,
        screenRows: screen.rows,
        screenCols: screen.cols,
        updatedAt: new Date(stat.mtimeMs).toISOString(),
      };

      projection.size = stat.size;
      projection.mtimeMs = stat.mtimeMs;
      projection.update = update;
      this.cache.set(logPath, projection);
      updates.push(update);
    }

    return updates;
  }

  dispose(): void {
    for (const projection of this.cache.values()) {
      projection.buffer.dispose();
    }
    this.cache.clear();
  }

  private resetProjection(logPath: string): CachedLogProjection {
    this.cache.get(logPath)?.buffer.dispose();
    return {
      size: 0,
      mtimeMs: 0,
      update: {
        session: inferSessionName(logPath),
        logPath,
        tail: "",
        tailOffset: 0,
        screenRows: this.screenRows,
        screenCols: this.screenCols,
        updatedAt: new Date(0).toISOString(),
      },
      buffer: new XtermTerminalScreenBuffer({
        rows: this.screenRows,
        cols: this.screenCols,
      }),
    };
  }
}

function readSessionLogChunk(input: {
  logPath: string;
  size: number;
  startOffset: number;
  maxReplayBytes: number;
}): string | undefined {
  const replayStart =
    input.startOffset === 0
      ? Math.max(0, input.size - input.maxReplayBytes - 4)
      : input.startOffset;
  const length = input.size - replayStart;
  let fd: number | undefined;
  try {
    fd = fs.openSync(input.logPath, "r");
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, replayStart);
    let text = buffer.toString("utf-8");
    if (input.startOffset === 0 && replayStart > 0) {
      text = dropFirstPartialLine(text);
    }
    return text;
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
