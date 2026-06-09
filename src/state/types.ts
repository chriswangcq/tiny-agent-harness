export type ProjectConfig = {
  schemaVersion: number;
  projectId: string;
  projectRoot: string;
  stateMode: "home-project" | "explicit";
  createdAt: string;
  updatedAt: string;
};

export type SnapshotMeta = {
  schemaVersion: number;
  version: number;
  updatedAt: string;
};

export type LedgerRecord = {
  id: string;
  schemaVersion: number;
  timestamp: string;
};

export type LockConfig = {
  lockTimeoutMs: number;
  lockRetryIntervalMs: number;
  staleLockTtlMs: number;
};

export const DEFAULT_LOCK_CONFIG: LockConfig = {
  lockTimeoutMs: 5000,
  lockRetryIntervalMs: 50,
  staleLockTtlMs: 5000,
};

export type LockOwner = {
  schemaVersion: number;
  ownerId: string;
  pid: number;
  hostname: string;
  purpose: string;
  createdAt: string;
  expiresAt: string;
};

export type StateRootInfo = {
  stateDir: string;
  projectRoot: string;
  projectConfig: ProjectConfig;
};
