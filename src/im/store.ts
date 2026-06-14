import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { DirectoryLock } from "../state/lock.js";

export type ImWriteLockInput = {
  stateRoot: string;
  lockName: string;
  purpose: string;
};

export type ImWriteLockEvent = ImWriteLockInput & {
  phase: "acquire" | "release";
};

export type ImStorePort = {
  readText: (filePath: string) => Promise<string | undefined>;
  writeText: (filePath: string, content: string) => Promise<void>;
  appendText: (filePath: string, content: string) => Promise<void>;
  withWriteLock: <T>(
    input: ImWriteLockInput,
    fn: () => T | Promise<T>,
  ) => Promise<T>;
};

export function createInMemoryImStore(
  initialFiles: Record<string, string> = {},
): ImStorePort & { files: Map<string, string>; lockEvents: ImWriteLockEvent[] } {
  const files = new Map<string, string>(Object.entries(initialFiles));
  const lockEvents: ImWriteLockEvent[] = [];
  return {
    files,
    lockEvents,
    async readText(filePath: string): Promise<string | undefined> {
      return files.get(filePath);
    },
    async writeText(filePath: string, content: string): Promise<void> {
      files.set(filePath, content);
    },
    async appendText(filePath: string, content: string): Promise<void> {
      files.set(filePath, `${files.get(filePath) ?? ""}${content}`);
    },
    async withWriteLock<T>(
      input: ImWriteLockInput,
      fn: () => T | Promise<T>,
    ): Promise<T> {
      lockEvents.push({ ...input, phase: "acquire" });
      try {
        return await fn();
      } finally {
        lockEvents.push({ ...input, phase: "release" });
      }
    },
  };
}

export function createNodeImStore(): ImStorePort {
  return {
    async readText(filePath: string): Promise<string | undefined> {
      try {
        return await fs.promises.readFile(filePath, "utf-8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return undefined;
        }
        throw error;
      }
    },
    async writeText(filePath: string, content: string): Promise<void> {
      await writeTextAtomic(filePath, content);
    },
    async appendText(filePath: string, content: string): Promise<void> {
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await appendTextSynced(filePath, content);
    },
    async withWriteLock<T>(
      input: ImWriteLockInput,
      fn: () => T | Promise<T>,
    ): Promise<T> {
      const locksDir = path.join(input.stateRoot, "locks");
      await fs.promises.mkdir(locksDir, { recursive: true });
      const lock = new DirectoryLock(locksDir, input.lockName);
      return lock.withLock(input.purpose, fn);
    },
  };
}

async function writeTextAtomic(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`,
  );
  try {
    await writeTextSynced(tmpPath, content);
    await fs.promises.rename(tmpPath, filePath);
    await fsyncDirectoryBestEffort(dir);
  } catch (error) {
    await fs.promises.rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function writeTextSynced(filePath: string, content: string): Promise<void> {
  const handle = await fs.promises.open(filePath, "w");
  try {
    await handle.writeFile(content, "utf-8");
    await handle.sync();
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function appendTextSynced(filePath: string, content: string): Promise<void> {
  const handle = await fs.promises.open(filePath, "a");
  try {
    await handle.writeFile(content, "utf-8");
    await handle.sync();
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function fsyncDirectoryBestEffort(dir: string): Promise<void> {
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(dir, "r");
    await handle.sync();
  } catch {
    // Directory fsync is best effort; some filesystems do not support it.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function readJsonFile<T>(
  store: ImStorePort,
  filePath: string,
): Promise<T | undefined> {
  const raw = await store.readText(filePath);
  if (raw === undefined || raw.trim().length === 0) {
    return undefined;
  }
  return JSON.parse(raw) as T;
}

export async function writeJsonFile(
  store: ImStorePort,
  filePath: string,
  value: unknown,
): Promise<void> {
  await store.writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function appendJsonlFile(
  store: ImStorePort,
  filePath: string,
  value: unknown,
): Promise<void> {
  await store.appendText(filePath, `${JSON.stringify(value)}\n`);
}

export async function readJsonlFile<T>(
  store: ImStorePort,
  filePath: string,
): Promise<T[]> {
  const raw = await store.readText(filePath);
  if (raw === undefined || raw.trim().length === 0) {
    return [];
  }
  const values: T[] = [];
  const lines = raw.split("\n");
  const hasCompleteTrailingLine = raw.endsWith("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      values.push(JSON.parse(trimmed) as T);
    } catch (error) {
      const isTrailingPartialLine = index === lines.length - 1 && !hasCompleteTrailingLine;
      if (isTrailingPartialLine) {
        break;
      }
      throw error;
    }
  }
  return values;
}
