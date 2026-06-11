import * as fs from "node:fs";
import * as path from "node:path";

export type ImStorePort = {
  readText: (filePath: string) => Promise<string | undefined>;
  writeText: (filePath: string, content: string) => Promise<void>;
  appendText: (filePath: string, content: string) => Promise<void>;
};

export function createInMemoryImStore(
  initialFiles: Record<string, string> = {},
): ImStorePort & { files: Map<string, string> } {
  const files = new Map<string, string>(Object.entries(initialFiles));
  return {
    files,
    async readText(filePath: string): Promise<string | undefined> {
      return files.get(filePath);
    },
    async writeText(filePath: string, content: string): Promise<void> {
      files.set(filePath, content);
    },
    async appendText(filePath: string, content: string): Promise<void> {
      files.set(filePath, `${files.get(filePath) ?? ""}${content}`);
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
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.writeFile(filePath, content, "utf-8");
    },
    async appendText(filePath: string, content: string): Promise<void> {
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.appendFile(filePath, content, "utf-8");
    },
  };
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
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    values.push(JSON.parse(trimmed) as T);
  }
  return values;
}
