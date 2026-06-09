export { StateRootResolver, buildProjectId } from "./root.js";
export type { StateRootPlan, StateRootResolverDeps } from "./root.js";
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
