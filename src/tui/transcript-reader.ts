import * as fs from "node:fs";
import * as path from "node:path";
import type { RunEvent, AgentRunStateData } from "../types/run.js";

export class TranscriptReader {
  private readonly transcriptPath: string;
  private readonly statePath: string;
  private byteOffset = 0;
  private partialLine = "";

  constructor(runDir: string) {
    this.transcriptPath = path.join(runDir, "transcript.jsonl");
    this.statePath = path.join(runDir, "state.json");
  }

  readNewEvents(): { events: RunEvent[]; errors: string[] } {
    // If file doesn't exist, return empty
    if (!fs.existsSync(this.transcriptPath)) {
      return { events: [], errors: [] };
    }

    const stat = fs.statSync(this.transcriptPath);
    if (stat.size <= this.byteOffset) {
      return { events: [], errors: [] };
    }

    // Read new bytes from offset
    const fd = fs.openSync(this.transcriptPath, "r");
    try {
      const bufSize = stat.size - this.byteOffset;
      const buf = Buffer.alloc(bufSize);
      fs.readSync(fd, buf, 0, bufSize, this.byteOffset);
      this.byteOffset = stat.size;

      const raw = this.partialLine + buf.toString("utf-8");
      const lines = raw.split("\n");

      // Last element might be partial (if file doesn't end with newline)
      this.partialLine = lines.pop() ?? "";

      const events: RunEvent[] = [];
      const errors: string[] = [];

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === "") continue;
        try {
          events.push(JSON.parse(trimmed) as RunEvent);
        } catch (e) {
          errors.push(`Failed to parse JSONL line: ${trimmed.slice(0, 100)}`);
        }
      }

      return { events, errors };
    } finally {
      fs.closeSync(fd);
    }
  }

  readState(): AgentRunStateData | undefined {
    if (!fs.existsSync(this.statePath)) return undefined;
    try {
      const raw = fs.readFileSync(this.statePath, "utf-8");
      return JSON.parse(raw) as AgentRunStateData;
    } catch {
      return undefined;
    }
  }

  get transcriptFilePath(): string {
    return this.transcriptPath;
  }

  get stateFilePath(): string {
    return this.statePath;
  }
}
