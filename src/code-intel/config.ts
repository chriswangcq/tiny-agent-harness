import * as fs from "node:fs";
import * as path from "node:path";
import type { CodeIntelConfig, CodeIntelLimits } from "./types.js";

const DEFAULT_LIMITS: CodeIntelLimits = {
  timeoutMs: 10000,
  maxResults: 50,
  previewLines: 2,
  maxOutputBytes: 20000,
};

const DEFAULT_TYPESCRIPT_SERVER = ["typescript-language-server", "--stdio"];

export type LoadedCodeIntelConfig = {
  config: CodeIntelConfig;
  configPath?: string;
};

export function loadCodeIntelConfig(workspaceRoot: string): LoadedCodeIntelConfig {
  const configPath = path.join(workspaceRoot, ".tiny-agent", "code-intel.json");
  const base = defaultConfig();

  if (!fs.existsSync(configPath)) {
    return { config: withEnvOverrides(base) };
  }

  const raw = JSON.parse(fs.readFileSync(configPath, "utf-8")) as Partial<CodeIntelConfig>;
  const config: CodeIntelConfig = {
    defaultLanguage: raw.defaultLanguage ?? base.defaultLanguage,
    languages: {
      typescript: {
        extensions:
          raw.languages?.typescript?.extensions ??
          base.languages.typescript.extensions,
        serverCommand:
          raw.languages?.typescript?.serverCommand ??
          base.languages.typescript.serverCommand,
        initializationOptions:
          raw.languages?.typescript?.initializationOptions ??
          base.languages.typescript.initializationOptions,
        workspaceFiles:
          raw.languages?.typescript?.workspaceFiles ??
          base.languages.typescript.workspaceFiles,
      },
    },
    limits: {
      ...base.limits,
      ...raw.limits,
    },
  };

  return { config: withEnvOverrides(config), configPath };
}

export function defaultConfig(): CodeIntelConfig {
  return {
    defaultLanguage: "typescript",
    languages: {
      typescript: {
        extensions: [".ts", ".tsx", ".js", ".jsx"],
        serverCommand: DEFAULT_TYPESCRIPT_SERVER,
        initializationOptions: {},
        workspaceFiles: ["tsconfig.json", "package.json"],
      },
    },
    limits: { ...DEFAULT_LIMITS },
  };
}

function withEnvOverrides(config: CodeIntelConfig): CodeIntelConfig {
  const serverCommand = process.env.CODEQ_TYPESCRIPT_SERVER_COMMAND;
  if (!serverCommand) {
    return config;
  }

  return {
    ...config,
    languages: {
      ...config.languages,
      typescript: {
        ...config.languages.typescript,
        serverCommand: parseCommandString(serverCommand),
      },
    },
  };
}

export function parseCommandString(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
      return parsed;
    }
    throw new Error("CODEQ_TYPESCRIPT_SERVER_COMMAND JSON value must be string[]");
  }

  return trimmed.split(/\s+/);
}
