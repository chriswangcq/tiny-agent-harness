#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { executeCodeIntelArgv } from "./commands.js";
import { asJson } from "./output.js";

export function isCodeIntelCliMain(input: {
  importMetaUrl: string;
  argvPath: string | undefined;
  realpath: (path: string) => string;
}): boolean {
  if (!input.argvPath) {
    return false;
  }

  try {
    return (
      input.realpath(fileURLToPath(input.importMetaUrl)) ===
      input.realpath(input.argvPath)
    );
  } catch {
    return false;
  }
}

export async function runCodeIntelCli(argv: string[]): Promise<number> {
  const envelope = await executeCodeIntelArgv(argv);
  process.stdout.write(asJson(envelope));
  return envelope.ok ? 0 : 1;
}

if (
  isCodeIntelCliMain({
    importMetaUrl: import.meta.url,
    argvPath: process.argv[1],
    realpath: realpathSync,
  })
) {
  runCodeIntelCli(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `[codeq] Fatal error: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
