#!/usr/bin/env node
import { executeCodeIntelArgv } from "./commands.js";
import { asJson } from "./output.js";

export async function runCodeIntelCli(argv: string[]): Promise<number> {
  const envelope = await executeCodeIntelArgv(argv);
  process.stdout.write(asJson(envelope));
  return envelope.ok ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
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
