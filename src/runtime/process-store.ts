import * as path from "node:path";
import * as fs from "node:fs";
import {
  createEmptyProcessSnapshot,
  upsertProcessRecord,
  type RuntimeProcessRecord,
  type RuntimeProcessSnapshot,
} from "./process-registry.js";

type ProcessStoreFsPort = Pick<
  typeof fs,
  | "existsSync"
  | "mkdirSync"
  | "readFileSync"
  | "writeFileSync"
  | "renameSync"
>;

export type JsonProcessRegistryStoreDeps = {
  filePath: string;
  nowIso: () => string;
  fs?: ProcessStoreFsPort;
};

export class JsonProcessRegistryStore {
  private readonly filePath: string;
  private readonly nowIso: () => string;
  private readonly fs: ProcessStoreFsPort;

  constructor(deps: JsonProcessRegistryStoreDeps) {
    this.filePath = deps.filePath;
    this.nowIso = deps.nowIso;
    this.fs = deps.fs ?? fs;
  }

  load(): RuntimeProcessSnapshot {
    if (!this.fs.existsSync(this.filePath)) {
      return createEmptyProcessSnapshot({ now: this.nowIso() });
    }
    const parsed = JSON.parse(
      this.fs.readFileSync(this.filePath, "utf-8"),
    ) as Partial<RuntimeProcessSnapshot>;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.processes)) {
      throw new Error(`Unsupported process registry snapshot at ${this.filePath}`);
    }
    if (typeof parsed.version !== "number" || parsed.version < 1) {
      throw new Error(`Invalid process registry version at ${this.filePath}`);
    }
    if (typeof parsed.updatedAt !== "string") {
      throw new Error(`Invalid process registry timestamp at ${this.filePath}`);
    }
    return parsed as RuntimeProcessSnapshot;
  }

  list(): RuntimeProcessRecord[] {
    return [...this.load().processes];
  }

  find(id: string): RuntimeProcessRecord | undefined {
    return this.load().processes.find((process) => process.id === id);
  }

  save(snapshot: RuntimeProcessSnapshot): void {
    this.fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    this.fs.writeFileSync(tmpPath, JSON.stringify(snapshot, null, 2), "utf-8");
    this.fs.renameSync(tmpPath, this.filePath);
  }

  upsert(process: RuntimeProcessRecord): RuntimeProcessSnapshot {
    const snapshot = upsertProcessRecord(this.load(), process, {
      now: this.nowIso(),
    });
    this.save(snapshot);
    return snapshot;
  }
}
