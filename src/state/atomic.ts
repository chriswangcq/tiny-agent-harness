import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { SnapshotMeta } from "./types.js";
import { DirectoryLock } from "./lock.js";

const ownerId = `pid-${process.pid}-rand-${crypto.randomBytes(4).toString("hex")}`;

export async function writeSnapshot<T extends SnapshotMeta>(
  filePath: string,
  data: T,
  lock: DirectoryLock,
): Promise<void> {
  await lock.withLock("write-snapshot", () => {
    // Read existing to check version
    const existing = readSnapshotSync<T>(filePath);
    const expectedVersion = existing ? existing.version + 1 : 1;

    if (data.version !== expectedVersion) {
      throw new Error(
        `Version mismatch: expected ${expectedVersion}, got ${data.version}. ` +
          `Re-read the snapshot before writing.`,
      );
    }

    // Write to tmp file
    const tmpPath = `${filePath}.tmp.${ownerId}`;
    const content = JSON.stringify(data, null, 2);
    fs.writeFileSync(tmpPath, content, "utf-8");

    // Atomic rename
    fs.renameSync(tmpPath, filePath);

    // Best-effort fsync parent dir
    try {
      const dirFd = fs.openSync(path.dirname(filePath), "r");
      fs.fsyncSync(dirFd);
      fs.closeSync(dirFd);
    } catch {
      // best effort
    }
  });
}

export function readSnapshot<T extends SnapshotMeta>(
  filePath: string,
): T | undefined {
  return readSnapshotSync<T>(filePath);
}

function readSnapshotSync<T extends SnapshotMeta>(
  filePath: string,
): T | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}
