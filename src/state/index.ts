export { StateRootResolver } from "./root.js";
export { DirectoryLock } from "./lock.js";
export type { LockError } from "./lock.js";
export { writeSnapshot, readSnapshot } from "./atomic.js";
export { LockedJsonlAppender } from "./jsonl.js";
export { DEFAULT_LOCK_CONFIG } from "./types.js";
export type {
  ProjectConfig,
  SnapshotMeta,
  LedgerRecord,
  LockConfig,
  LockOwner,
  StateRootInfo,
} from "./types.js";
