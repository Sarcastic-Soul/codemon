import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DEFAULT_MCP_TIMEOUT, enabledServers, loadMcpServers } from "./config.ts";
import { MCP_PREFIX, mcpToolName } from "./index.ts";
import { checkPermission } from "../permissions/gate.ts";
import {
  BUILTIN_TOOL_NAMES,
  getTool,
  buildToolSet,
  registerTool,
  unregisterToolsByPrefix,
} from "../tools/registry.ts";
import { z } from "zod";
import type { ToolDefinition } from "../tools/types.ts";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "codemon-mcp-"));
  fs.mkdirSync(path.join(root, ".codemon"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  unregisterToolsByPrefix(MCP_PREFIX);
});

function writeProjectConfig(body: unknown) {
  fs.writeFileSync(path.join(root, ".codemon", "config.json"), JSON.stringify(body));
}

describe("mcpServers config", () => {
  test("a declared server is read with its defaults filled in", () => {
    writeProjectConfig({
      mcpServers: { github: { command: "npx", args: ["-y", "server-github"] } },
    });

    const servers = loadMcpServers(root);
    expect(servers.github).toBeDefined();
    expect(servers.github!.command).toBe("npx");
    expect(servers.github!.args).toEqual(["-y", "server-github"]);
    expect(servers.github!.enabled).toBe(true);
    expect(servers.github!.timeout).toBe(DEFAULT_MCP_TIMEOUT);
  });

  test("a server with no command is dropped rather than spawned", () => {
    writeProjectConfig({ mcpServers: { broken: { args: ["x"] } } });
    expect(loadMcpServers(root).broken).toBeUndefined();
  });

  test("enabled:false keeps the declaration but not the process", () => {
    writeProjectConfig({
      mcpServers: {
        on: { command: "a" },
        off: { command: "b", enabled: false },
      },
    });

    const servers = loadMcpServers(root);
    expect(Object.keys(servers).sort()).toEqual(["off", "on"]);
    expect(enabledServers(servers).map(([n]) => n)).toEqual(["on"]);
  });

  test("an unknown permission level is ignored rather than trusted", () => {
    writeProjectConfig({
      mcpServers: {
        s: { command: "a", permissions: { good: "read", bad: "superuser" } },
      },
    });

    const perms = loadMcpServers(root).s!.permissions!;
    expect(perms.good).toBe("read");
    expect(perms.bad).toBeUndefined();
  });

  test("an unparseable config file is ignored rather than fatal", () => {
    fs.writeFileSync(path.join(root, ".codemon", "config.json"), "{ not json");
    expect(() => loadMcpServers(root)).not.toThrow();
    expect(loadMcpServers(root)).toEqual({});
  });

  test("a project declaration overrides a same-named one in codemon.json", () => {
    fs.writeFileSync(
      path.join(root, "codemon.json"),
      JSON.stringify({ mcpServers: { s: { command: "from-codemon-json" } } }),
    );
    writeProjectConfig({ mcpServers: { s: { command: "from-dot-codemon" } } });

    expect(loadMcpServers(root).s!.command).toBe("from-dot-codemon");
  });

  test("no mcpServers block yields nothing, not an error", () => {
    writeProjectConfig({ model: "openai:gpt-4o" });
    expect(loadMcpServers(root)).toEqual({});
  });
});

describe("remote tool permissions", () => {
  test("an MCP tool with no declared permission asks in standard mode", () => {
    // The requirement that shaped the `network` level: filing remote tools
    // under `write` would have auto-allowed them here, since standard mode
    // auto-allows write.
    expect(checkPermission(mcpToolName("github", "search"), "network", "standard")).toBe("ask");
  });

  test("it also asks in safe mode and runs in yolo", () => {
    expect(checkPermission(mcpToolName("github", "search"), "network", "safe")).toBe("ask");
    expect(checkPermission(mcpToolName("github", "search"), "network", "yolo")).toBe("allow");
  });
});

describe("dynamic registry", () => {
  const fake = (name: string): ToolDefinition => ({
    name,
    description: "test",
    parameters: z.object({}),
    permissionLevel: "network",
    async execute() { return "ok"; },
  });

  test("a registered tool is reachable and appears in the toolset", () => {
    const name = mcpToolName("test", "thing");
    expect(registerTool(fake(name))).toBe(true);

    expect(getTool(name)).toBeDefined();
    expect(Object.keys(buildToolSet())).toContain(name);
  });

  test("a remote tool cannot shadow a built-in", () => {
    // A server that could redefine `bash` would be a permission bypass wearing
    // a familiar name.
    expect(registerTool(fake("bash"))).toBe(false);
    expect(getTool("bash")!.permissionLevel).toBe("bash");
    expect(BUILTIN_TOOL_NAMES.has("bash")).toBe(true);
  });

  test("unregistering by prefix removes only that server's tools", () => {
    registerTool(fake(mcpToolName("a", "one")));
    registerTool(fake(mcpToolName("b", "two")));

    expect(unregisterToolsByPrefix(`${MCP_PREFIX}a__`)).toBe(1);
    expect(getTool(mcpToolName("a", "one"))).toBeUndefined();
    expect(getTool(mcpToolName("b", "two"))).toBeDefined();
    expect(getTool("read_file")).toBeDefined();
  });

  test("a built-in survives an aggressive prefix sweep", () => {
    unregisterToolsByPrefix("");
    expect(getTool("read_file")).toBeDefined();
    expect(getTool("bash")).toBeDefined();
  });
});
