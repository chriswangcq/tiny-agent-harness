import { createRequire } from "node:module";

import { stripManagedShellScreenNoise } from "./screen-filter.js";

const require = createRequire(import.meta.url);
const { Terminal } = require("@xterm/headless") as typeof import("@xterm/headless");

export type TerminalScreenBufferSize = {
  rows: number;
  cols: number;
};

export type TerminalScreenBufferSnapshot = TerminalScreenBufferSize & {
  text: string;
  hasScrollback: boolean;
};

export interface TerminalScreenBuffer {
  write(chunk: string): void;
  snapshot(): Promise<TerminalScreenBufferSnapshot>;
  dispose(): void;
}

export class XtermTerminalScreenBuffer implements TerminalScreenBuffer {
  private readonly terminal: import("@xterm/headless").Terminal;
  private pendingWrite: Promise<void> = Promise.resolve();
  private pendingOutput = "";
  private disposed = false;
  private pendingFilterText = "";

  constructor(private readonly size: TerminalScreenBufferSize) {
    this.terminal = new Terminal({
      cols: positiveInteger(size.cols) ?? 80,
      rows: positiveInteger(size.rows) ?? 24,
      allowProposedApi: true,
      convertEol: false,
      scrollback: 1000,
      disableStdin: true,
      logLevel: "off",
    });
  }

  write(chunk: string): void {
    if (this.disposed || chunk.length === 0) {
      return;
    }

    const filtered = stripManagedShellScreenNoise(
      this.pendingFilterText + chunk,
    );
    this.pendingFilterText = filtered.pending;
    this.pendingOutput += filtered.output;
  }

  async snapshot(): Promise<TerminalScreenBufferSnapshot> {
    await this.flushPendingOutput();
    const buffer = this.terminal.buffer.active;
    const lines: string[] = [];
    for (let row = 0; row < this.terminal.rows; row += 1) {
      const line = buffer.getLine(buffer.baseY + row);
      lines.push(line?.translateToString(true, 0, this.terminal.cols) ?? "");
    }
    return {
      rows: this.terminal.rows,
      cols: this.terminal.cols,
      text: lines.join("\n"),
      hasScrollback: buffer.baseY > 0,
    };
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.terminal.dispose();
  }

  private async flushPendingOutput(): Promise<void> {
    if (this.pendingOutput.length === 0) {
      await this.pendingWrite;
      return;
    }

    const output = this.pendingOutput;
    this.pendingOutput = "";
    this.pendingWrite = this.pendingWrite.then(
      () =>
        new Promise<void>((resolve) => {
          this.terminal.write(output, resolve);
        }),
    );
    await this.pendingWrite;
    if (this.pendingOutput.length > 0) {
      await this.flushPendingOutput();
    }
  }
}

function positiveInteger(value: number): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  const integer = Math.floor(value);
  return integer > 0 ? integer : undefined;
}
