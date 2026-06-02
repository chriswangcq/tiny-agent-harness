import * as fs from "node:fs";
import * as path from "node:path";
import type { McpServerConfig } from "./client.js";

export type McpRegistry = {
  servers: Record<string, Omit<McpServerConfig, "name">>;
};

const DEFAULT_REGISTRY_PATH = ".tiny-agent/mcp-servers.json";

export class McpRegistryStore {
  private registryPath: string;

  constructor(registryPath?: string) {
    this.registryPath = registryPath ?? DEFAULT_REGISTRY_PATH;
  }

  load(): McpRegistry {
    try {
      const raw = fs.readFileSync(this.registryPath, "utf-8");
      return JSON.parse(raw) as McpRegistry;
    } catch (e: unknown) {
      if (e instanceof Error && (e as NodeJS.ErrnoException).code === "ENOENT") {
        return { servers: {} };
      }
      // JSON parse error or permission error — don't silently swallow
      throw e instanceof Error
        ? new Error(`Failed to load MCP registry: ${e.message}`)
        : new Error(`Failed to load MCP registry: ${String(e)}`);
    }
  }

  save(registry: McpRegistry): void {
    const dir = path.dirname(this.registryPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    // Atomic write via temp file + rename
    const tmpPath = this.registryPath + ".tmp";
    fs.writeFileSync(tmpPath, JSON.stringify(registry, null, 2), "utf-8");
    fs.renameSync(tmpPath, this.registryPath);
  }

  list(): McpServerConfig[] {
    const registry = this.load();
    return Object.entries(registry.servers).map(([name, config]) => ({
      name,
      ...config,
    }));
  }

  get(name: string): McpServerConfig | undefined {
    const registry = this.load();
    const entry = registry.servers[name];
    if (!entry) return undefined;
    return { name, ...entry };
  }

  add(config: McpServerConfig): void {
    const registry = this.load();
    const { name, ...rest } = config;
    registry.servers[name] = rest;
    this.save(registry);
  }

  remove(name: string): boolean {
    const registry = this.load();
    if (!registry.servers[name]) return false;
    delete registry.servers[name];
    this.save(registry);
    return true;
  }
}
