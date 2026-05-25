import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { LockedJsonlAppender } from "../src/state/jsonl.js";
import { DirectoryLock } from "../src/state/lock.js";

type TestRecord = {
  id: string;
  schemaVersion: number;
  timestamp: string;
  data: string;
};

describe("LockedJsonlAppender", () => {
  const tmpDirs: string[] = [];

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jsonl-test-"));
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

  function makeRecord(data: string): TestRecord {
    return {
      id: `rec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      data,
    };
  }

  function setup() {
    const tmpDir = makeTmpDir();
    const locksDir = path.join(tmpDir, "locks");
    fs.mkdirSync(locksDir, { recursive: true });
    const lock = new DirectoryLock(locksDir, "test-jsonl");
    const filePath = path.join(tmpDir, "events.jsonl");
    const appender = new LockedJsonlAppender(filePath, lock);
    return { tmpDir, locksDir, lock, filePath, appender };
  }

  it("appends records to file", async () => {
    const { filePath, appender } = setup();

    await appender.append(makeRecord("first"));
    await appender.append(makeRecord("second"));

    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim() !== "");
    expect(lines.length).toBe(2);

    const parsed0 = JSON.parse(lines[0]);
    expect(parsed0.data).toBe("first");

    const parsed1 = JSON.parse(lines[1]);
    expect(parsed1.data).toBe("second");
  });

  it("readSince returns records from offset", async () => {
    const { appender } = setup();

    await appender.append(makeRecord("alpha"));
    await appender.append(makeRecord("beta"));

    const first = appender.readSince(0);
    expect(first.records.length).toBe(2);
    expect(first.errors.length).toBe(0);
    expect(first.newOffset).toBeGreaterThan(0);

    await appender.append(makeRecord("gamma"));

    const second = appender.readSince(first.newOffset);
    expect(second.records.length).toBe(1);
    expect((second.records[0] as TestRecord).data).toBe("gamma");
    expect(second.errors.length).toBe(0);
    expect(second.newOffset).toBeGreaterThan(first.newOffset);
  });

  it("readSince returns empty for missing file", () => {
    const { appender } = setup();

    const result = appender.readSince(0);
    expect(result.records).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.newOffset).toBe(0);
  });

  it("readSince handles malformed lines", () => {
    const { filePath, appender } = setup();

    fs.writeFileSync(filePath, "not-valid-json\n", "utf-8");

    const result = appender.readSince(0);
    expect(result.records.length).toBe(0);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain("Failed to parse JSONL line");
    expect(result.errors[0]).toContain("not-valid-json");
  });

  it("append creates file if not exists", async () => {
    const { filePath, appender } = setup();

    expect(fs.existsSync(filePath)).toBe(false);

    await appender.append(makeRecord("create-me"));

    expect(fs.existsSync(filePath)).toBe(true);
    const content = fs.readFileSync(filePath, "utf-8").trim();
    const parsed = JSON.parse(content);
    expect(parsed.data).toBe("create-me");
  });

  it("records have required LedgerRecord fields", async () => {
    const { appender } = setup();

    await appender.append(makeRecord("check-fields"));

    const result = appender.readSince(0);
    expect(result.records.length).toBe(1);

    const record = result.records[0] as TestRecord;
    expect(typeof record.id).toBe("string");
    expect(record.id.length).toBeGreaterThan(0);
    expect(typeof record.schemaVersion).toBe("number");
    expect(typeof record.timestamp).toBe("string");
    expect(record.timestamp.length).toBeGreaterThan(0);
  });
});
