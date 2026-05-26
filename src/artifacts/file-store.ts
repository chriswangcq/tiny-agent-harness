import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type {
  AgentObservation,
  StashFileToolRequest,
} from "../types/index.js";

export type FileArtifactMeta = {
  version: 1;
  artifactId: string;
  name: string;
  bytes: number;
  sha256: string;
  encoding: "utf8" | "base64";
  toolCallId: string;
  description?: string;
  createdAt: string;
  contentFile: "content";
};

export type FileArtifactWriteResult = {
  artifactId: string;
  sourcePath: string;
  destinationPath: string;
  bytes: number;
  sha256: string;
};

export class FileArtifactStore {
  private readonly rootDir: string;
  private readonly cwd: string;

  constructor(options: { rootDir: string; cwd?: string }) {
    this.rootDir = options.rootDir;
    this.cwd = options.cwd ?? process.cwd();
  }

  stash(request: StashFileToolRequest): AgentObservation {
    const bytes =
      request.encoding === "base64"
        ? Buffer.from(request.content, "base64")
        : Buffer.from(request.content, "utf8");
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    const name = sanitizeFileName(request.name ?? "artifact.bin");
    const artifactId = makeArtifactId(request.toolCallId, name, sha256);
    const artifactDir = this.artifactDir(artifactId);
    const contentPath = path.join(artifactDir, "content");
    const metaPath = path.join(artifactDir, "meta.json");
    const meta: FileArtifactMeta = {
      version: 1,
      artifactId,
      name,
      bytes: bytes.byteLength,
      sha256,
      encoding: request.encoding,
      toolCallId: request.toolCallId,
      description: request.description,
      createdAt: new Date().toISOString(),
      contentFile: "content",
    };

    fs.mkdirSync(artifactDir, { recursive: true });
    atomicWriteFile(contentPath, bytes);
    atomicWriteFile(metaPath, Buffer.from(`${JSON.stringify(meta, null, 2)}\n`));

    const writeCommand = `node dist/cli/main.js artifact write ${artifactId} <target-path>`;

    return {
      kind: "file_artifact",
      recoverable: false,
      artifactId,
      name,
      bytes: bytes.byteLength,
      sha256,
      contentPath,
      writeCommand,
      message:
        `Stashed file artifact ${artifactId} (${bytes.byteLength} bytes, sha256 ${sha256}). ` +
        `Use bash to write it: ${writeCommand}`,
    };
  }

  readMeta(artifactId: string): FileArtifactMeta {
    const metaPath = path.join(this.artifactDir(artifactId), "meta.json");
    return JSON.parse(fs.readFileSync(metaPath, "utf8")) as FileArtifactMeta;
  }

  list(): FileArtifactMeta[] {
    if (!fs.existsSync(this.rootDir)) {
      return [];
    }

    return fs
      .readdirSync(this.rootDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => this.readMeta(entry.name))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  write(artifactId: string, destination: string): FileArtifactWriteResult {
    const meta = this.readMeta(artifactId);
    const contentPath = path.join(this.artifactDir(artifactId), meta.contentFile);
    const bytes = fs.readFileSync(contentPath);
    const actualHash = crypto.createHash("sha256").update(bytes).digest("hex");
    if (actualHash !== meta.sha256) {
      throw new Error(
        `artifact ${artifactId} content hash mismatch: expected ${meta.sha256}, got ${actualHash}`,
      );
    }

    const destinationPath = this.resolveDestination(destination);
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    atomicWriteFile(destinationPath, bytes);

    return {
      artifactId,
      sourcePath: contentPath,
      destinationPath,
      bytes: bytes.byteLength,
      sha256: actualHash,
    };
  }

  private artifactDir(artifactId: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(artifactId) || artifactId.includes("..")) {
      throw new Error(`invalid artifact id: ${artifactId}`);
    }
    return path.join(this.rootDir, artifactId);
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
}

function makeArtifactId(
  toolCallId: string,
  name: string,
  sha256: string,
): string {
  const call = sanitizeIdPart(toolCallId);
  const basename = sanitizeIdPart(path.parse(name).name || "file").slice(0, 32);
  return `file-${call}-${basename}-${sha256.slice(0, 12)}`;
}

function sanitizeFileName(name: string): string {
  const basename = path.basename(name).trim();
  return basename.length > 0 ? basename : "artifact.bin";
}

function sanitizeIdPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "x";
}

function atomicWriteFile(filePath: string, data: Buffer): void {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, data);
  fs.renameSync(tempPath, filePath);
}
