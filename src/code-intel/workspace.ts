import * as fs from "node:fs";
import * as path from "node:path";

const WORKSPACE_MARKERS = ["tsconfig.json", "package.json", ".git"];

export function findWorkspaceRoot(cwd: string): string {
  let current = path.resolve(cwd);

  while (true) {
    if (WORKSPACE_MARKERS.some((marker) => fs.existsSync(path.join(current, marker)))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return path.resolve(cwd);
    }
    current = parent;
  }
}

export function ensureFileExists(filePath: string): void {
  const stat = fs.statSync(filePath, { throwIfNoEntry: false });
  if (!stat?.isFile()) {
    throw new Error(`File not found: ${filePath}`);
  }
}

export function findLocalBin(workspaceRoot: string, executable: string): string | undefined {
  const candidate = path.join(workspaceRoot, "node_modules", ".bin", executable);
  if (fs.existsSync(candidate)) {
    return candidate;
  }
  return undefined;
}

export function resolveExecutable(
  executable: string,
  workspaceRoot: string,
  envPath = process.env.PATH ?? "",
): string | undefined {
  if (executable.includes(path.sep)) {
    const absolute = path.isAbsolute(executable)
      ? executable
      : path.resolve(workspaceRoot, executable);
    return fs.existsSync(absolute) ? absolute : undefined;
  }

  const local = findLocalBin(workspaceRoot, executable);
  if (local) {
    return local;
  }

  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    const candidate = path.join(dir, executable);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

export function resolveCommand(
  command: string[],
  workspaceRoot: string,
): string[] | undefined {
  const [executable, ...args] = command;
  if (!executable) {
    return undefined;
  }

  const resolved = resolveExecutable(executable, workspaceRoot);
  return resolved ? [resolved, ...args] : undefined;
}
