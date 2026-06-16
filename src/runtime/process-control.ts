import { spawn } from "node:child_process";
import type { ProcessSpawnerPort } from "./run-supervisor.js";

export type ProcessControlPort = {
  isAlive(pid: number): boolean;
  signal(pid: number, signal: NodeJS.Signals): boolean;
};

export const nodeProcessSpawner: ProcessSpawnerPort = {
  spawn(executable, args, options) {
    return spawn(executable, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: [...options.stdio] as [
        "ignore" | "pipe",
        "ignore" | "pipe",
        "ignore" | "pipe",
      ],
      detached: options.detached,
    });
  },
};

export const nodeProcessControl: ProcessControlPort = {
  isAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) {
      return false;
    }
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return isErrno(error, "EPERM");
    }
  },
  signal(pid, signal) {
    if (!Number.isInteger(pid) || pid <= 0) {
      return false;
    }
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  },
};

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
