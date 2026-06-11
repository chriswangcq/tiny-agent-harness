import * as fs from "node:fs";
import * as path from "node:path";
import type { RuntimeEvent } from "./events.js";

type RuntimeEventStoreFsPort = Pick<
  typeof fs,
  "appendFileSync" | "mkdirSync"
>;

export type JsonlRuntimeEventSinkDeps = {
  filePath: string;
  fs?: RuntimeEventStoreFsPort;
};

export class JsonlRuntimeEventSink {
  private readonly filePath: string;
  private readonly fs: RuntimeEventStoreFsPort;

  constructor(deps: JsonlRuntimeEventSinkDeps) {
    this.filePath = deps.filePath;
    this.fs = deps.fs ?? fs;
  }

  append(event: RuntimeEvent): void {
    this.fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.fs.appendFileSync(this.filePath, `${JSON.stringify(event)}\n`, "utf-8");
  }
}
