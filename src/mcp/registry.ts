import * as fs from "node:fs";
import * as path from "node:path";
import type { McpServerConfig } from "./client.js";
import { DirectoryLock } from "../state/lock.js";

export type McpRegistry = {
  servers: Record<string, Omit<McpServerConfig, "name">>;
};

const DEFAULT_REGISTRY_PATH = ".tiny-agent/mcp-servers.json";

export class McpRegistryStore {
  private registryPath: string;
  private lock: DirectoryLock;

  constructor(registryPath?: string, stateDir?: string) {
    this.registryPath = registryPath ?? DEFAULT_REGISTRY_PATH;
    const locksDir = stateDir
      ? path.join(stateDir, "locks")
      : path.join(path.dirname(this.registryPath), "locks");
    if (!fs.existsSync(locksDir)) { fs.mkdirSync(locksDir, { recursive: true }); }
    this.lock = new DirectoryLock(locksDir, "mcp-registry");
  }

  load(): McpRegistry {
    try {
      const raw = fs.readFileSync(this.registryPath, "utf-8");
      return JSON.parse(raw) as McpRegistry;
    } catch (e: unknown) {
      if (e instanceof Error && (e as NodeJS.ErrnoException).code === "ENOENT") {
        return { servers: {} };
      }
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
    const tmpPath = this.registryPath + ".tmp." + process.pid;
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

  async add(config: McpServerConfig): Promise<void> {
    await this.lock.withLock("add", () => {
      const registry = this.load();
      const { name, ...rest } = config;
      registry.servers[name] = rest;
      this.save(registry);
    });
  }

  async remove(name: string): Promise<boolean> {
    return await this.lock.withLock("remove", () => {
      const registry = this.load();
      if (!registry.servers[name]) return false;
      delete registry.servers[name];
      this.save(registry);
      return true;
    });
  }
}
