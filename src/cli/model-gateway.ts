import { DeepSeekFimAdapter } from "../model/adapter.js";
import { serveModelGateway } from "../model/gateway-host.js";
import {
  loadDeepSeekRuntimeConfig,
  missingDeepSeekApiKeyMessage,
} from "./runtime-config.js";

export async function runModelGatewayCli(args: string[]): Promise<number> {
  let modelOverride: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const value = args[index + 1];
    if (arg === "--model" && value) {
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

  const model = new DeepSeekFimAdapter({
    apiKey: deepseek.apiKey,
    baseUrl: deepseek.baseUrl,
    model: modelOverride ?? deepseek.model,
    thinkingMaxTokens: 4096,
    decisionMaxTokens: 2048,
  });

  await serveModelGateway({
    model,
    input: process.stdin,
    output: process.stdout,
  });
  return 0;
}
