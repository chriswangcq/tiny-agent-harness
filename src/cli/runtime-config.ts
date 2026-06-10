import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const RUNTIME_CONFIG_SCHEMA_VERSION = 1;
export const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com/beta";
export const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-pro";

export type RuntimeConfigFile = {
  schemaVersion: typeof RUNTIME_CONFIG_SCHEMA_VERSION;
  providers?: {
    deepseek?: {
      apiKey?: string;
      baseUrl?: string;
      model?: string;
    };
  };
};

export type RuntimeConfigFsPort = Pick<typeof fs, "existsSync" | "readFileSync">;

export type DeepSeekRuntimeConfig = {
  apiKey?: string;
  baseUrl: string;
  model: string;
  configPath: string;
  sources: {
    apiKey: "env" | "config" | "missing";
    baseUrl: "env" | "config" | "default";
    model: "env" | "config" | "default";
  };
};

export function planRuntimeConfigPath(homeDir: string): string {
  return path.join(homeDir, ".tiny-agent", "config.json");
}

export function parseRuntimeConfigFile(
  raw: string,
  configPath: string,
): RuntimeConfigFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Failed to parse runtime config JSON at ${configPath}`);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Invalid runtime config at ${configPath}: expected object`);
  }

  const config = parsed as Record<string, unknown>;
  if (config.schemaVersion !== RUNTIME_CONFIG_SCHEMA_VERSION) {
    throw new Error(
      `Invalid runtime config at ${configPath}: unsupported schemaVersion ${String(config.schemaVersion)}`,
    );
  }

  const providers = config.providers;
  if (providers !== undefined && (!providers || typeof providers !== "object")) {
    throw new Error(`Invalid runtime config at ${configPath}: providers must be an object`);
  }

  const deepseek = (providers as { deepseek?: unknown } | undefined)?.deepseek;
  if (deepseek !== undefined && (!deepseek || typeof deepseek !== "object")) {
    throw new Error(`Invalid runtime config at ${configPath}: providers.deepseek must be an object`);
  }

  if (deepseek && typeof deepseek === "object") {
    const provider = deepseek as Record<string, unknown>;
    for (const key of ["apiKey", "baseUrl", "model"] as const) {
      if (provider[key] !== undefined && typeof provider[key] !== "string") {
        throw new Error(
          `Invalid runtime config at ${configPath}: providers.deepseek.${key} must be a string`,
        );
      }
    }
  }

  return parsed as RuntimeConfigFile;
}

export function resolveDeepSeekRuntimeConfig(input: {
  env: Record<string, string | undefined>;
  config: RuntimeConfigFile | undefined;
  configPath: string;
}): DeepSeekRuntimeConfig {
  const provider = input.config?.providers?.deepseek;
  const envApiKey = input.env.DEEPSEEK_API_KEY?.trim();
  const configApiKey = provider?.apiKey?.trim();
  const envBaseUrl = input.env.DEEPSEEK_BASE_URL?.trim();
  const configBaseUrl = provider?.baseUrl?.trim();
  const envModel = input.env.MODEL_NAME?.trim();
  const configModel = provider?.model?.trim();

  return {
    apiKey: envApiKey || configApiKey || undefined,
    baseUrl: envBaseUrl || configBaseUrl || DEFAULT_DEEPSEEK_BASE_URL,
    model: envModel || configModel || DEFAULT_DEEPSEEK_MODEL,
    configPath: input.configPath,
    sources: {
      apiKey: envApiKey ? "env" : configApiKey ? "config" : "missing",
      baseUrl: envBaseUrl ? "env" : configBaseUrl ? "config" : "default",
      model: envModel ? "env" : configModel ? "config" : "default",
    },
  };
}

export function loadDeepSeekRuntimeConfig(deps: {
  env?: Record<string, string | undefined>;
  homeDir?: () => string;
  fs?: RuntimeConfigFsPort;
} = {}): DeepSeekRuntimeConfig {
  const env = deps.env ?? process.env;
  const homeDir = deps.homeDir ?? (() => os.homedir());
  const fsPort = deps.fs ?? fs;
  const configPath = planRuntimeConfigPath(homeDir());
  const config = fsPort.existsSync(configPath)
    ? parseRuntimeConfigFile(fsPort.readFileSync(configPath, "utf-8"), configPath)
    : undefined;

  return resolveDeepSeekRuntimeConfig({ env, config, configPath });
}

export function missingDeepSeekApiKeyMessage(configPath: string): string {
  return (
    "DeepSeek API key is required.\n" +
    `  Put it in ${configPath} as providers.deepseek.apiKey.\n` +
    "  Or set DEEPSEEK_API_KEY in the environment for a one-off override."
  );
}
