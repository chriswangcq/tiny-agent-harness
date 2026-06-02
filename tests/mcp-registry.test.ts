import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { McpRegistryStore } from "../src/mcp/registry.js";

const tmpBase = path.join(os.tmpdir(), "mcp-test-" + process.pid);
const stateDir = path.join(tmpBase, "state");

beforeEach(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
  fs.mkdirSync(stateDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

describe("McpRegistryStore", () => {
  it("ENOENT returns empty registry", () => {
    const p = path.join(tmpBase, "nonexist.json");
    const store = new McpRegistryStore(p, stateDir);
    expect(store.list()).toEqual([]);
  });

  it("corrupt JSON throws", () => {
    const p = path.join(tmpBase, "corrupt.json");
    fs.writeFileSync(p, "not json");
    const store = new McpRegistryStore(p, stateDir);
    expect(() => store.load()).toThrow("Failed to load MCP registry");
  });

  it("add and list", async () => {
    const p = path.join(tmpBase, "registry.json");
    const store = new McpRegistryStore(p, stateDir);
    await store.add({ name: "s1", command: "echo", args: ["hi"] });
    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("s1");
    expect(list[0].command).toBe("echo");
  });

  it("get returns config or undefined", async () => {
    const p = path.join(tmpBase, "registry.json");
    const store = new McpRegistryStore(p, stateDir);
    await store.add({ name: "s1", command: "cmd", args: [] });
    expect(store.get("s1")?.command).toBe("cmd");
    expect(store.get("nope")).toBeUndefined();
  });

  it("remove existing server", async () => {
    const p = path.join(tmpBase, "registry.json");
    const store = new McpRegistryStore(p, stateDir);
    await store.add({ name: "s1", command: "cmd", args: [] });
    const removed = await store.remove("s1");
    expect(removed).toBe(true);
    expect(store.list()).toEqual([]);
  });

  it("remove non-existing returns false", async () => {
    const p = path.join(tmpBase, "registry.json");
    const store = new McpRegistryStore(p, stateDir);
    const removed = await store.remove("nope");
    expect(removed).toBe(false);
  });

  it("atomic save produces correct file", async () => {
    const p = path.join(tmpBase, "registry.json");
    const store = new McpRegistryStore(p, stateDir);
    await store.add({ name: "s1", command: "cmd", args: ["--flag"] });
    const raw = fs.readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.servers.s1.command).toBe("cmd");
    expect(parsed.servers.s1.args).toEqual(["--flag"]);
    expect(fs.readdirSync(path.dirname(p)).filter(f => f.endsWith(".tmp"))).toHaveLength(0);
  });
});
