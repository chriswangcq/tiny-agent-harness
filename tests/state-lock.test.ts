import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { DirectoryLock } from "../src/state/lock.js";

describe("DirectoryLock", () => {
  let tmpDir: string;

  function createLocksDir(): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lock-test-"));
    return tmpDir;
  }

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("acquire and release", async () => {
    const locksDir = createLocksDir();
    const lock = new DirectoryLock(locksDir, "test");

    await lock.acquire("unit-test");

    const lockDir = path.join(locksDir, "test.lock");
    expect(fs.existsSync(lockDir)).toBe(true);
    expect(fs.existsSync(path.join(lockDir, "owner.json"))).toBe(true);
    expect(lock.isHeld).toBe(true);

    lock.release();

    expect(fs.existsSync(lockDir)).toBe(false);
    expect(lock.isHeld).toBe(false);
  });

  it("tryAcquire returns false when already held", () => {
    const locksDir = createLocksDir();
    const lock1 = new DirectoryLock(locksDir, "test");
    const lock2 = new DirectoryLock(locksDir, "test");

    expect(lock1.tryAcquire("first")).toBe(true);
    expect(lock2.tryAcquire("second")).toBe(false);

    lock1.release();
    expect(lock2.tryAcquire("second")).toBe(true);
    lock2.release();
  });

  it("withLock releases on success", async () => {
    const locksDir = createLocksDir();
    const lock = new DirectoryLock(locksDir, "test");

    const result = await lock.withLock("unit-test", () => {
      expect(lock.isHeld).toBe(true);
      return 42;
    });

    expect(result).toBe(42);
    expect(lock.isHeld).toBe(false);
  });

  it("withLock releases on error", async () => {
    const locksDir = createLocksDir();
    const lock = new DirectoryLock(locksDir, "test");

    await expect(
      lock.withLock("unit-test", () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(lock.isHeld).toBe(false);
    expect(fs.existsSync(path.join(locksDir, "test.lock"))).toBe(false);
  });

  it("acquire waits for release", async () => {
    const locksDir = createLocksDir();
    const lock1 = new DirectoryLock(locksDir, "test");
    lock1.tryAcquire("first");

    const lock2 = new DirectoryLock(locksDir, "test");
    const acquirePromise = lock2.acquire("second");

    setTimeout(() => lock1.release(), 100);

    await acquirePromise;
    expect(lock2.isHeld).toBe(true);
    lock2.release();
  });

  it("acquire times out", async () => {
    const locksDir = createLocksDir();
    const lock1 = new DirectoryLock(locksDir, "test");
    lock1.tryAcquire("blocker");

    const lock2 = new DirectoryLock(locksDir, "test", {
      lockTimeoutMs: 200,
    });

    await expect(lock2.acquire("waiter")).rejects.toMatchObject({
      code: "LOCK_TIMEOUT",
    });

    lock1.release();
  });

  it("isStale detects expired lock", async () => {
    const locksDir = createLocksDir();
    const lock1 = new DirectoryLock(locksDir, "test", { staleLockTtlMs: 1 });
    lock1.tryAcquire("short-lived");

    await new Promise((r) => setTimeout(r, 50));

    // Use a separate instance to check staleness
    const checker = new DirectoryLock(locksDir, "test");
    expect(checker.isStale()).toBe(true);

    lock1.release();
  });

  it("steal takes over stale lock", async () => {
    const locksDir = createLocksDir();
    const lock1 = new DirectoryLock(locksDir, "test", { staleLockTtlMs: 1 });
    lock1.tryAcquire("short-lived");

    await new Promise((r) => setTimeout(r, 50));

    const lock2 = new DirectoryLock(locksDir, "test");
    lock2.steal("takeover");

    expect(lock2.isHeld).toBe(true);

    // Verify stale directory exists
    const entries = fs.readdirSync(locksDir);
    const staleEntries = entries.filter((e) => e.includes(".stale."));
    expect(staleEntries.length).toBe(1);

    lock2.release();
  });

  it("owner.json has correct fields", async () => {
    const locksDir = createLocksDir();
    const lock = new DirectoryLock(locksDir, "test");

    await lock.acquire("check-fields");

    const ownerPath = path.join(locksDir, "test.lock", "owner.json");
    const owner = JSON.parse(fs.readFileSync(ownerPath, "utf-8"));

    expect(owner.schemaVersion).toBe(1);
    expect(owner.pid).toBe(process.pid);
    expect(owner.hostname).toBe(os.hostname());
    expect(owner.purpose).toBe("check-fields");
    expect(typeof owner.ownerId).toBe("string");
    expect(typeof owner.createdAt).toBe("string");
    expect(typeof owner.expiresAt).toBe("string");

    lock.release();
  });
});
