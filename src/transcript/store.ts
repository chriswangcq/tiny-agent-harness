import * as fs from "node:fs";
import * as path from "node:path";
import type { RunEvent } from "../types/run.js";

export class TranscriptStore {
  private readonly dirPath: string;
  private readonly transcriptPath: string;
  private readonly statePath: string;

  constructor(runDir: string) {
    this.dirPath = runDir;
    this.transcriptPath = path.join(runDir, "transcript.jsonl");
    this.statePath = path.join(runDir, "state.json");
  }

  ensureDir(): void {
    fs.mkdirSync(this.dirPath, { recursive: true });
  }

  append(event: RunEvent): void {
    const line = JSON.stringify(event) + "\n";
    fs.appendFileSync(this.transcriptPath, line, "utf-8");
  }

  saveState(state: unknown): void {
    fs.writeFileSync(this.statePath, JSON.stringify(state, null, 2), "utf-8");
  }

  loadState<T>(): T | null {
    if (!fs.existsSync(this.statePath)) {
      return null;
    }
    const raw = fs.readFileSync(this.statePath, "utf-8");
    return JSON.parse(raw) as T;
  }

  get transcriptFilePath(): string {
    return this.transcriptPath;
  }

  get stateFilePath(): string {
    return this.statePath;
  }
}
