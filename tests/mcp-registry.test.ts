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
  it("constructor rejects empty stateDir", () => {
    expect(() => new McpRegistryStore("")).toThrow("requires a stateDir");
  });

  it("ENOENT returns empty registry", () => {
    const dir = path.join(tmpBase, "fresh");
    const store = new McpRegistryStore(dir);
    expect(store.list()).toEqual([]);
  });

  it("corrupt JSON throws", () => {
    const dir = path.join(tmpBase, "corrupt");
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, "mcp-servers.json");
    fs.writeFileSync(p, "not json");
    const store = new McpRegistryStore(dir);
    expect(() => store.load()).toThrow("Failed to load MCP registry");
  });

  it("add and list", async () => {
    const dir = path.join(tmpBase, "add-list");
    const store = new McpRegistryStore(dir);
    await store.add({ name: "s1", command: "echo", args: ["hi"] });
    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("s1");
    expect(list[0].command).toBe("echo");
  });

  it("get returns config or undefined", async () => {
    const dir = path.join(tmpBase, "get");
    const store = new McpRegistryStore(dir);
    await store.add({ name: "s1", command: "cmd", args: [] });
    expect(store.get("s1")?.command).toBe("cmd");
    expect(store.get("nope")).toBeUndefined();
  });

  it("remove existing server", async () => {
    const dir = path.join(tmpBase, "remove");
    const store = new McpRegistryStore(dir);
    await store.add({ name: "s1", command: "cmd", args: [] });
    const removed = await store.remove("s1");
    expect(removed).toBe(true);
    expect(store.list()).toEqual([]);
  });

  it("remove non-existing returns false", async () => {
    const dir = path.join(tmpBase, "remove-none");
    const store = new McpRegistryStore(dir);
    const removed = await store.remove("nope");
    expect(removed).toBe(false);
  });

  it("atomic save produces correct file", async () => {
    const dir = path.join(tmpBase, "atomic");
    const store = new McpRegistryStore(dir);
    await store.add({ name: "s1", command: "cmd", args: ["--flag"] });
    const p = store.getRegistryPath();
    const raw = fs.readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.servers.s1.command).toBe("cmd");
    expect(parsed.servers.s1.args).toEqual(["--flag"]);
    expect(fs.readdirSync(path.dirname(p)).filter(f => f.endsWith(".tmp"))).toHaveLength(0);
  });

  it("lock directory is created under stateDir", async () => {
    const dir = path.join(tmpBase, "locks");
    const store = new McpRegistryStore(dir);
    await store.add({ name: "s1", command: "cmd", args: [] });
    const locksDir = path.join(dir, "locks");
    expect(fs.existsSync(locksDir)).toBe(true);
  });

  it("getRegistryPath derives path from stateDir", () => {
    const dir = path.join(tmpBase, "path-test");
    const store = new McpRegistryStore(dir);
    expect(store.getRegistryPath()).toBe(path.join(dir, "mcp-servers.json"));
  });

  it("registry path is consistent across store instances", async () => {
    const dir = path.join(tmpBase, "consistent");
    const store1 = new McpRegistryStore(dir);
    const store2 = new McpRegistryStore(dir);
    await store1.add({ name: "shared", command: "echo", args: [] });
    expect(store2.list()).toHaveLength(1);
    expect(store2.get("shared")?.command).toBe("echo");
  });
});
