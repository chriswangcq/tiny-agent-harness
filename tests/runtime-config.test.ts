import { describe, expect, it } from "vitest";
import {
  DEFAULT_DEEPSEEK_BASE_URL,
  DEFAULT_DEEPSEEK_MODEL,
  loadDeepSeekRuntimeConfig,
  missingDeepSeekApiKeyMessage,
  parseRuntimeConfigFile,
  planRuntimeConfigPath,
  resolveDeepSeekRuntimeConfig,
  type RuntimeConfigFsPort,
} from "../src/cli/runtime-config.js";

describe("runtime config", () => {
  it("plans the user-level config path under ~/.tiny-agent", () => {
    expect(planRuntimeConfigPath("/home/user")).toBe(
      "/home/user/.tiny-agent/config.json",
    );
  });

  it("resolves DeepSeek config from the runtime config file", () => {
    const config = parseRuntimeConfigFile(
      JSON.stringify({
        schemaVersion: 1,
        providers: {
          deepseek: {
            apiKey: "config-key",
            baseUrl: "https://deepseek.example/beta",
            model: "deepseek-test",
          },
        },
      }),
      "/home/user/.tiny-agent/config.json",
    );

    expect(
      resolveDeepSeekRuntimeConfig({
        env: {},
        config,
        configPath: "/home/user/.tiny-agent/config.json",
      }),
    ).toMatchObject({
      apiKey: "config-key",
      baseUrl: "https://deepseek.example/beta",
      model: "deepseek-test",
      sources: {
        apiKey: "config",
        baseUrl: "config",
        model: "config",
      },
    });
  });

  it("lets environment variables override file values", () => {
    const result = resolveDeepSeekRuntimeConfig({
      env: {
        DEEPSEEK_API_KEY: "env-key",
        DEEPSEEK_BASE_URL: "https://env.example/beta",
        MODEL_NAME: "env-model",
      },
      config: {
        schemaVersion: 1,
        providers: {
          deepseek: {
            apiKey: "config-key",
            baseUrl: "https://config.example/beta",
            model: "config-model",
          },
        },
      },
      configPath: "/home/user/.tiny-agent/config.json",
    });

    expect(result).toMatchObject({
      apiKey: "env-key",
      baseUrl: "https://env.example/beta",
      model: "env-model",
      sources: {
        apiKey: "env",
        baseUrl: "env",
        model: "env",
      },
    });
  });

  it("uses defaults for base URL and model when no config exists", () => {
    const result = resolveDeepSeekRuntimeConfig({
      env: {},
      config: undefined,
      configPath: "/home/user/.tiny-agent/config.json",
    });

    expect(result).toMatchObject({
      apiKey: undefined,
      baseUrl: DEFAULT_DEEPSEEK_BASE_URL,
      model: DEFAULT_DEEPSEEK_MODEL,
      sources: {
        apiKey: "missing",
        baseUrl: "default",
        model: "default",
      },
    });
  });

  it("rejects malformed or unsupported config files", () => {
    expect(() => parseRuntimeConfigFile("not-json", "/cfg")).toThrow(
      "Failed to parse runtime config JSON",
    );
    expect(() =>
      parseRuntimeConfigFile(JSON.stringify({ schemaVersion: 2 }), "/cfg"),
    ).toThrow("unsupported schemaVersion 2");
    expect(() =>
      parseRuntimeConfigFile(
        JSON.stringify({
          schemaVersion: 1,
          providers: { deepseek: { apiKey: 123 } },
        }),
        "/cfg",
      ),
    ).toThrow("providers.deepseek.apiKey must be a string");
  });

  it("loads config through explicit fs and home-dir ports", () => {
    const configPath = "/home/user/.tiny-agent/config.json";
    const files = new Map([
      [
        configPath,
        JSON.stringify({
          schemaVersion: 1,
          providers: { deepseek: { apiKey: "config-key" } },
        }),
      ],
    ]);
    const fsPort: RuntimeConfigFsPort = {
      existsSync: (filePath) => files.has(String(filePath)),
      readFileSync: (filePath) => files.get(String(filePath)) ?? "",
    };

    expect(
      loadDeepSeekRuntimeConfig({
        env: {},
        homeDir: () => "/home/user",
        fs: fsPort,
      }),
    ).toMatchObject({
      apiKey: "config-key",
      configPath,
      sources: { apiKey: "config" },
    });
  });

  it("points missing-key errors at the user config file", () => {
    expect(missingDeepSeekApiKeyMessage("/home/user/.tiny-agent/config.json"))
      .toContain("/home/user/.tiny-agent/config.json");
  });
});
