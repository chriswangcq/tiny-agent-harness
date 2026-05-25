import * as fs from "node:fs";
import type { LedgerRecord } from "./types.js";
import { DirectoryLock } from "./lock.js";

export class LockedJsonlAppender {
  private readonly filePath: string;
  private readonly lock: DirectoryLock;

  constructor(filePath: string, lock: DirectoryLock) {
    this.filePath = filePath;
    this.lock = lock;
  }

  async append<T extends LedgerRecord>(record: T): Promise<void> {
    await this.lock.withLock("jsonl-append", () => {
      const line = JSON.stringify(record) + "\n";
      fs.appendFileSync(this.filePath, line, "utf-8");
    });
  }

  readSince(byteOffset: number): {
    records: unknown[];
    errors: string[];
    newOffset: number;
  } {
    if (!fs.existsSync(this.filePath)) {
      return { records: [], errors: [], newOffset: byteOffset };
    }

    const stat = fs.statSync(this.filePath);
    if (stat.size <= byteOffset) {
      return { records: [], errors: [], newOffset: byteOffset };
    }

    const fd = fs.openSync(this.filePath, "r");
    try {
      const bufSize = stat.size - byteOffset;
      const buf = Buffer.alloc(bufSize);
      fs.readSync(fd, buf, 0, bufSize, byteOffset);

      const raw = buf.toString("utf-8");
      const lines = raw.split("\n");

      const records: unknown[] = [];
      const errors: string[] = [];

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === "") continue;
        try {
          records.push(JSON.parse(trimmed));
        } catch {
          errors.push(`Failed to parse JSONL line: ${trimmed.slice(0, 100)}`);
        }
      }

      return { records, errors, newOffset: stat.size };
    } finally {
      fs.closeSync(fd);
    }
  }

  get path(): string {
    return this.filePath;
  }
}
