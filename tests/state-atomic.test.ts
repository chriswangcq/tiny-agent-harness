import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { writeSnapshot, readSnapshot } from "../src/state/atomic.js";
import { DirectoryLock } from "../src/state/lock.js";
import type { SnapshotMeta } from "../src/state/types.js";

type TestSnapshot = SnapshotMeta & { name: string };

describe("AtomicJsonWriter", () => {
  const tmpDirs: string[] = [];

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-test-"));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tmpDirs) {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
    tmpDirs.length = 0;
  });

  function setup() {
    const tmpDir = makeTmpDir();
    const locksDir = path.join(tmpDir, "locks");
    fs.mkdirSync(locksDir, { recursive: true });
    const lock = new DirectoryLock(locksDir, "test-snapshot");
    const filePath = path.join(tmpDir, "state.json");
    return { tmpDir, locksDir, lock, filePath };
  }

  it("writes and reads snapshot", async () => {
    const { lock, filePath } = setup();

    const data: TestSnapshot = {
      schemaVersion: 1,
      version: 1,
      updatedAt: new Date().toISOString(),
      name: "hello",
    };

    await writeSnapshot(filePath, data, lock);

    const result = readSnapshot<TestSnapshot>(filePath);
    expect(result).toBeDefined();
    expect(result!.version).toBe(1);
    expect(result!.name).toBe("hello");
    expect(result!.schemaVersion).toBe(1);
  });

  it("version must be 1 for new file", async () => {
    const { lock, filePath } = setup();

    const data: TestSnapshot = {
      schemaVersion: 1,
      version: 2,
      updatedAt: new Date().toISOString(),
      name: "bad",
    };

    await expect(writeSnapshot(filePath, data, lock)).rejects.toThrow(
      "Version mismatch",
    );
  });

  it("version must increment", async () => {
    const { lock, filePath } = setup();

    const v1: TestSnapshot = {
      schemaVersion: 1,
      version: 1,
      updatedAt: new Date().toISOString(),
      name: "first",
    };
    await writeSnapshot(filePath, v1, lock);

    // Skip version 2 — should fail
    const v3: TestSnapshot = {
      schemaVersion: 1,
      version: 3,
      updatedAt: new Date().toISOString(),
      name: "skip",
    };
    await expect(writeSnapshot(filePath, v3, lock)).rejects.toThrow(
      "Version mismatch",
    );

    // Correct next version — should succeed
    const v2: TestSnapshot = {
      schemaVersion: 1,
      version: 2,
      updatedAt: new Date().toISOString(),
      name: "second",
    };
    await writeSnapshot(filePath, v2, lock);

    const result = readSnapshot<TestSnapshot>(filePath);
    expect(result!.version).toBe(2);
    expect(result!.name).toBe("second");
  });

  it("readSnapshot returns undefined for missing file", () => {
    const { filePath } = setup();
    expect(readSnapshot(filePath)).toBeUndefined();
  });

  it("readSnapshot returns undefined for invalid JSON", () => {
    const { filePath } = setup();
    fs.writeFileSync(filePath, "not valid json {{{{", "utf-8");
    expect(readSnapshot(filePath)).toBeUndefined();
  });

  it("no tmp files left after successful write", async () => {
    const { tmpDir, lock, filePath } = setup();

    const data: TestSnapshot = {
      schemaVersion: 1,
      version: 1,
      updatedAt: new Date().toISOString(),
      name: "clean",
    };
    await writeSnapshot(filePath, data, lock);

    const entries = fs.readdirSync(tmpDir);
    const tmpFiles = entries.filter((e) => e.includes(".tmp."));
    expect(tmpFiles).toHaveLength(0);
  });

  it("atomic: file is either old or new, never partial", async () => {
    const { lock, filePath } = setup();

    const v1: TestSnapshot = {
      schemaVersion: 1,
      version: 1,
      updatedAt: new Date().toISOString(),
      name: "old-content",
    };
    await writeSnapshot(filePath, v1, lock);

    const v2: TestSnapshot = {
      schemaVersion: 1,
      version: 2,
      updatedAt: new Date().toISOString(),
      name: "new-content",
    };
    await writeSnapshot(filePath, v2, lock);

    const result = readSnapshot<TestSnapshot>(filePath);
    expect(result).toBeDefined();
    expect(result!.version).toBe(2);
    expect(result!.name).toBe("new-content");

    // Verify the file is valid JSON (not truncated)
    const raw = fs.readFileSync(filePath, "utf-8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});
