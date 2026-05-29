import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { RunEvent } from "../types/run.js";

export type RunDebugArtifact = {
  path: string;
  relativePath: string;
  bytes: number;
  sha256: string;
};

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

  writeDebugArtifact(relativePath: string, content: string): RunDebugArtifact {
    const artifactRelativePath = normalizeArtifactPath(relativePath);
    const artifactPath = path.join(this.dirPath, artifactRelativePath);
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, content, "utf-8");
    return {
      path: artifactPath,
      relativePath: artifactRelativePath,
      bytes: Buffer.byteLength(content, "utf-8"),
      sha256: createHash("sha256").update(content, "utf-8").digest("hex"),
    };
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

function normalizeArtifactPath(relativePath: string): string {
  if (path.isAbsolute(relativePath)) {
    throw new Error(`Debug artifact path must be relative: ${relativePath}`);
  }
  const parts = relativePath.split(/[\\/]+/u).filter(Boolean);
  if (parts.length === 0 || parts.includes("..")) {
    throw new Error(`Invalid debug artifact path: ${relativePath}`);
  }
  return path.join(...parts);
}
