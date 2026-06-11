import { executeCodeIntelArgv } from "./commands.js";
import { runCodeIntelHostCli } from "./host.js";
import { asJson } from "./output.js";

export async function runCodeIntelCli(argv: string[]): Promise<number> {
  if (argv[0] === "host") {
    return await runCodeIntelHostCli(argv.slice(1));
  }
  const envelope = await executeCodeIntelArgv(argv);
  process.stdout.write(asJson(envelope));
  return envelope.ok ? 0 : 1;
}
