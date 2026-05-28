import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type {
  AgentObservation,
  StashFileToolRequest,
} from "../types/index.js";

export type StashedFileMeta = {
  version: 1;
  stashId: string;
  name: string;
  bytes: number;
  sha256: string;
  encoding: "utf8" | "base64";
  toolCallId: string;
  description?: string;
  createdAt: string;
  contentFile: "content";
};

export type MaterializeFileResult = {
  stashId: string;
  sourcePath: string;
  destinationPath: string;
  bytes: number;
  sha256: string;
};

export class StashFileStore {
  private readonly rootDir: string;
  private readonly cwd: string;
  private readonly stateDir?: string;

  constructor(options: { rootDir: string; cwd?: string; stateDir?: string }) {
    this.rootDir = options.rootDir;
    this.cwd = options.cwd ?? process.cwd();
    this.stateDir = options.stateDir;
  }

  stash(request: StashFileToolRequest): AgentObservation {
    const bytes = decodeContent(request.content, request.encoding);
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    const name = sanitizeFileName(request.name ?? "stashed-file.bin");
    const stashId = this.createStashId();
    const stashDir = this.stashDir(stashId);
    const contentPath = path.join(stashDir, "content");
    const metaPath = path.join(stashDir, "meta.json");
    const materializeCommand = this.materializeCommand(stashId, name);
    const meta: StashedFileMeta = {
      version: 1,
      stashId,
      name,
      bytes: bytes.byteLength,
      sha256,
      encoding: request.encoding,
      toolCallId: request.toolCallId,
      description: request.description,
      createdAt: new Date().toISOString(),
      contentFile: "content",
    };

    fs.mkdirSync(stashDir, { recursive: true });
    atomicWriteFile(contentPath, bytes);
    atomicWriteFile(metaPath, Buffer.from(`${JSON.stringify(meta, null, 2)}\n`));

    return {
      kind: "stash_file",
      recoverable: false,
      stashId,
      name,
      bytes: bytes.byteLength,
      materializeCommand,
      message:
        `Stashed file ${stashId} (${bytes.byteLength} bytes). ` +
        `Use bash to materialize it: ${materializeCommand}`,
    };
  }

  readMeta(stashId: string): StashedFileMeta {
    const metaPath = path.join(this.stashDir(stashId), "meta.json");
    return JSON.parse(fs.readFileSync(metaPath, "utf8")) as StashedFileMeta;
  }

  list(): StashedFileMeta[] {
    if (!fs.existsSync(this.rootDir)) {
      return [];
    }

    return fs
      .readdirSync(this.rootDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        try {
          return this.readMeta(entry.name);
        } catch {
          return undefined;
        }
      })
      .filter((meta): meta is StashedFileMeta => meta !== undefined)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  materialize(stashId: string, destination: string): MaterializeFileResult {
    const meta = this.readMeta(stashId);
    const contentPath = path.join(this.stashDir(stashId), meta.contentFile);
    const bytes = fs.readFileSync(contentPath);
    const actualHash = crypto.createHash("sha256").update(bytes).digest("hex");
    if (actualHash !== meta.sha256) {
      throw new Error(
        `stash ${stashId} content hash mismatch: expected ${meta.sha256}, got ${actualHash}`,
      );
    }

    const destinationPath = this.resolveDestination(destination);
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    atomicWriteFile(destinationPath, bytes);

    return {
      stashId,
      sourcePath: contentPath,
      destinationPath,
      bytes: bytes.byteLength,
      sha256: actualHash,
    };
  }

  private stashDir(stashId: string): string {
    if (!/^[A-Za-z0-9._-]+$/u.test(stashId) || stashId.includes("..")) {
      throw new Error(`invalid stash id: ${stashId}`);
    }
    return path.join(this.rootDir, stashId);
  }

  private resolveDestination(destination: string): string {
    if (!destination) {
      throw new Error("destination path is required");
    }

    if (destination === "~") {
      return os.homedir();
    }
    if (destination.startsWith("~/")) {
      return path.join(os.homedir(), destination.slice(2));
    }
    if (path.isAbsolute(destination)) {
      return destination;
    }
    return path.resolve(this.cwd, destination);
  }

  private createStashId(): string {
    for (let attempt = 0; attempt < 10; attempt++) {
      const stashId = `f-${crypto.randomBytes(5).toString("hex")}`;
      if (!fs.existsSync(this.stashDir(stashId))) {
        return stashId;
      }
    }
    throw new Error("failed to allocate a unique stash id");
  }

  private materializeCommand(stashId: string, name: string): string {
    const targetPath =
      name === "stashed-file.bin" ? "<target-path>" : shellQuote(name);
    const stateDirFlag =
      this.stateDir === undefined
        ? ""
        : ` --state-dir ${shellQuote(this.stateDir)}`;
    return `node dist/cli/main.js file materialize ${stashId} ${targetPath}${stateDirFlag}`;
  }
}

function decodeContent(content: string, encoding: "utf8" | "base64"): Buffer {
  if (encoding === "utf8") {
    return Buffer.from(content, "utf8");
  }

  return Buffer.from(content.replace(/\s+/gu, ""), "base64");
}

function sanitizeFileName(name: string): string {
  const basename = path.basename(name).trim();
  return basename.length > 0 ? basename : "stashed-file.bin";
}

function atomicWriteFile(filePath: string, data: Buffer): void {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, data);
  fs.renameSync(tempPath, filePath);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}
