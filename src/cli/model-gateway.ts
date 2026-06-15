import { DeepSeekFimAdapter } from "../model/adapter.js";
import { listenModelGatewaySocket } from "../model/gateway-host.js";
import {
  loadDeepSeekRuntimeConfig,
  missingDeepSeekApiKeyMessage,
} from "./runtime-config.js";

export async function runModelGatewayCli(args: string[]): Promise<number> {
  let modelOverride: string | undefined;
  let socketPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const value = args[index + 1];
    if (arg === "--socket" && value) {
      socketPath = value;
      index += 1;
    } else if (arg === "--model" && value) {
      modelOverride = value;
      index += 1;
    } else {
      process.stderr.write(`[tiny-agent model-gateway] Unknown option: ${arg}\n`);
      return 2;
    }
  }

  const deepseek = loadDeepSeekRuntimeConfig();
  if (!deepseek.apiKey) {
    process.stderr.write(`${missingDeepSeekApiKeyMessage(deepseek.configPath)}\n`);
    return 1;
  }
  if (!socketPath) {
    process.stderr.write("Usage: tiny-agent model-gateway --socket <path> [--model <model>]\n");
    return 2;
  }

  const model = new DeepSeekFimAdapter({
    apiKey: deepseek.apiKey,
    baseUrl: deepseek.baseUrl,
    model: modelOverride ?? deepseek.model,
    thinkingMaxTokens: 4096,
    decisionMaxTokens: 2048,
  });

  const server = await listenModelGatewaySocket({
    model,
    socketPath,
  });
  await new Promise<void>((resolve, reject) => {
    server.once("close", resolve);
    server.once("error", reject);
  });
  return 0;
}
