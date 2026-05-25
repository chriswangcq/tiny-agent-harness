import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import type { LockConfig, LockOwner } from "./types.js";
import { DEFAULT_LOCK_CONFIG } from "./types.js";

export type LockError = {
  code: "LOCK_TIMEOUT";
  message: string;
  lock: string;
};

export class DirectoryLock {
  private readonly lockDir: string;
  private readonly config: LockConfig;
  private readonly ownerId: string;
  private held = false;

  constructor(locksDir: string, name: string, config?: Partial<LockConfig>) {
    this.lockDir = path.join(locksDir, `${name}.lock`);
    this.config = { ...DEFAULT_LOCK_CONFIG, ...config };
    this.ownerId = `pid-${process.pid}-rand-${crypto.randomBytes(4).toString("hex")}`;
  }

  async acquire(purpose: string): Promise<void> {
    const deadline = Date.now() + this.config.lockTimeoutMs;
    while (Date.now() < deadline) {
      if (this.tryAcquire(purpose)) return;

      // Check for stale lock and steal if needed
      if (this.isStale()) {
        this.steal(purpose);
        return;
      }

      await sleep(this.config.lockRetryIntervalMs);
    }

    // Final attempt
    if (this.tryAcquire(purpose)) return;
    if (this.isStale()) {
      this.steal(purpose);
      return;
    }

    const error: LockError = {
      code: "LOCK_TIMEOUT",
      message: `Could not acquire lock ${path.basename(this.lockDir)}`,
      lock: this.lockDir,
    };
    throw error;
  }

  tryAcquire(purpose: string): boolean {
    try {
      fs.mkdirSync(this.lockDir, { recursive: false });
    } catch (e: any) {
      if (e.code === "EEXIST") return false;
      throw e;
    }

    // Write owner.json
    const now = new Date();
    const owner: LockOwner = {
      schemaVersion: 1,
      ownerId: this.ownerId,
      pid: process.pid,
      hostname: os.hostname(),
      purpose,
      createdAt: now.toISOString(),
      expiresAt: new Date(
        now.getTime() + this.config.staleLockTtlMs,
      ).toISOString(),
    };

    fs.writeFileSync(
      path.join(this.lockDir, "owner.json"),
      JSON.stringify(owner, null, 2),
      "utf-8",
    );

    this.held = true;
    return true;
  }

  release(): void {
    if (!this.held) return;

    const ownerPath = path.join(this.lockDir, "owner.json");
    try {
      if (fs.existsSync(ownerPath)) {
        fs.unlinkSync(ownerPath);
      }
      fs.rmdirSync(this.lockDir);
    } catch {
      // Best effort release
    }
    this.held = false;
  }

  async withLock<T>(purpose: string, fn: () => T | Promise<T>): Promise<T> {
    await this.acquire(purpose);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  isStale(): boolean {
    const ownerPath = path.join(this.lockDir, "owner.json");
    try {
      if (!fs.existsSync(ownerPath)) {
        // Lock dir exists but no owner.json — treat as stale
        return fs.existsSync(this.lockDir);
      }
      const owner = JSON.parse(
        fs.readFileSync(ownerPath, "utf-8"),
      ) as LockOwner;
      return new Date(owner.expiresAt).getTime() < Date.now();
    } catch {
      return false;
    }
  }

  steal(purpose: string): void {
    const staleName = `${path.basename(this.lockDir, ".lock")}.stale.${Date.now()}.lock`;
    const staleDir = path.join(path.dirname(this.lockDir), staleName);

    try {
      fs.renameSync(this.lockDir, staleDir);
    } catch {
      // Another process may have already stolen it
    }

    // Now try to acquire fresh
    if (!this.tryAcquire(purpose)) {
      throw new Error(`Failed to acquire lock after steal: ${this.lockDir}`);
    }
  }

  get isHeld(): boolean {
    return this.held;
  }

  get lockPath(): string {
    return this.lockDir;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
