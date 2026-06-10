import { executeCodeIntelArgv } from "./commands.js";
import { asJson } from "./output.js";

export async function runCodeIntelCli(argv: string[]): Promise<number> {
  const envelope = await executeCodeIntelArgv(argv);
  process.stdout.write(asJson(envelope));
  return envelope.ok ? 0 : 1;
}
