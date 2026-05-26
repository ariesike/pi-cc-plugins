import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import extension from "../index.js";
import { parseSource } from "../src/source.js";
import { discoverMcpConfigPaths, resolvePlugin } from "../src/plugin.js";
import {
	collectPluginMcpServers,
	readPluginMcpServers,
	syncProjectMcpConfig,
	getProjectMcpConfigPath,
	getProjectMcpSidecarPath,
} from "../src/mcp.js";
import type { ResolvedPlugin } from "../src/types.js";

const tmpDir = join(homedir(), ".pi-cc-plugins-mcp-test-tmp");

function createMockPi() {
	const handlers: Record<string, Function> = {};
	const mockPi = {
		on: vi.fn((event: string, handler: Function) => {
			handlers[event] = handler;
		}),
		registerTool: vi.fn(),
		registerShortcut: vi.fn(),
		registerCommand: vi.fn(),
	};
	return { mockPi, handlers };
}

function createMockCtx(cwd: string) {
	return {
		cwd,
		ui: {
			notify: vi.fn(),
			confirm: vi.fn(),
			setStatus: vi.fn(),
			setEditorText: vi.fn(),
		},
		hasUI: true,
		sessionManager: {},
	};
}

function writeJson(filePath: string, value: unknown): void {
	mkdirSync(join(filePath, ".."), { recursive: true });
	writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function createPlugin(name: string, files: Record<string, unknown>): string {
	const pluginDir = join(tmpDir, name);
	mkdirSync(join(pluginDir, ".claude-plugin"), { recursive: true });
	writeJson(join(pluginDir, ".claude-plugin", "plugin.json"), { name });

	for (const [relativePath, value] of Object.entries(files)) {
		writeJson(join(pluginDir, relativePath), value);
	}

	return pluginDir;
}

function pluginFixture(name: string, mcpConfigPaths: string[]): ResolvedPlugin {
	return {
		rootDir: join(tmpDir, name),
		name,
		skillPaths: [],
		agentPaths: [],
		mcpConfigPaths,
		source: parseSource(`local:${join(tmpDir, name)}`),
	};
}

beforeEach(() => {
	mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("discoverMcpConfigPaths", () => {
	it("discovers mcp.json, .mcp.json, and manifest mcp paths in order", () => {
		const pluginDir = createPlugin("mcp-plugin", {
			"mcp.json": { mcpServers: { first: { command: "first" } } },
			".mcp.json": { mcpServers: { second: { command: "second" } } },
			"custom/mcp.json": { mcpServers: { third: { command: "third" } } },
		});
		writeJson(join(pluginDir, ".claude-plugin", "plugin.json"), {
			name: "mcp-plugin",
			mcp: "./custom/mcp.json",
		});

		expect(discoverMcpConfigPaths(pluginDir)).toEqual([
			join(pluginDir, "mcp.json"),
			join(pluginDir, ".mcp.json"),
			join(pluginDir, "custom", "mcp.json"),
		]);
	});

	it("ignores manifest mcp paths outside the plugin root", () => {
		const pluginDir = createPlugin("unsafe-plugin", {
			"mcp.json": { mcpServers: { safe: { command: "safe" } } },
		});
		writeJson(join(pluginDir, ".claude-plugin", "plugin.json"), {
			name: "unsafe-plugin",
			mcp: "../outside.json",
		});
		writeJson(join(tmpDir, "outside.json"), { mcpServers: { unsafe: { command: "unsafe" } } });

		expect(discoverMcpConfigPaths(pluginDir)).toEqual([
			join(pluginDir, "mcp.json"),
		]);
	});

	it("adds discovered MCP config paths to resolved plugins", () => {
		const pluginDir = createPlugin("resolved-plugin", {
			"mcp.json": { mcpServers: { server: { command: "server" } } },
		});
		const plugin = resolvePlugin(parseSource(`local:${pluginDir}`));

		expect(plugin.mcpConfigPaths).toEqual([join(pluginDir, "mcp.json")]);
	});
});

describe("readPluginMcpServers", () => {
	it("extracts only object-shaped MCP server definitions", () => {
		const configPath = join(tmpDir, "servers.json");
		writeJson(configPath, {
			settings: { directTools: true },
			imports: ["cursor"],
			mcpServers: {
				valid: { command: "npx", args: ["server"] },
				invalid: null,
			},
		});

		const result = readPluginMcpServers(configPath);

		expect(Object.keys(result.servers)).toEqual(["valid"]);
		expect(result.servers.valid.command).toBe("npx");
		expect(result.warnings).toHaveLength(1);
	});

	it("supports mcp-servers as a compatibility key", () => {
		const configPath = join(tmpDir, "servers.json");
		writeJson(configPath, {
			"mcp-servers": {
				compat: { command: "compat" },
			},
		});

		expect(Object.keys(readPluginMcpServers(configPath).servers)).toEqual(["compat"]);
	});
});

describe("collectPluginMcpServers", () => {
	it("namespaces servers and lets later config files win for duplicate original names", () => {
		const firstPath = join(tmpDir, "first.json");
		const secondPath = join(tmpDir, "second.json");
		writeJson(firstPath, { mcpServers: { browser: { command: "first" } } });
		writeJson(secondPath, { mcpServers: { browser: { command: "second" } } });

		const result = collectPluginMcpServers([
			pluginFixture("My Plugin", [firstPath, secondPath]),
		]);

		expect(result.servers).toHaveLength(1);
		expect(result.servers[0].generatedName).toBe("my-plugin__browser");
		expect(result.servers[0].definition.command).toBe("second");
	});

	it("warns and keeps the first definition for generated name collisions", () => {
		const firstPath = join(tmpDir, "first.json");
		const secondPath = join(tmpDir, "second.json");
		writeJson(firstPath, { mcpServers: { "foo-bar": { command: "first" } } });
		writeJson(secondPath, { mcpServers: { "foo_bar": { command: "second" } } });

		const result = collectPluginMcpServers([
			pluginFixture("plugin", [firstPath]),
			pluginFixture("plugin", [secondPath]),
		]);

		expect(result.servers).toHaveLength(1);
		expect(result.servers[0].definition.command).toBe("first");
		expect(result.warnings[0]).toContain("collides");
	});
});

describe("syncProjectMcpConfig", () => {
	it("does not create project MCP files when no servers or managed state exist", () => {
		const projectDir = join(tmpDir, "empty-project");
		const result = syncProjectMcpConfig(projectDir, []);

		expect(result.changed).toBe(false);
		expect(existsSync(getProjectMcpConfigPath(projectDir))).toBe(false);
		expect(existsSync(getProjectMcpSidecarPath(projectDir))).toBe(false);
	});

	it("preserves user config, skips user collisions, writes sidecar metadata, and cleans stale managed entries", () => {
		const projectDir = join(tmpDir, "project");
		const pluginDir = createPlugin("my-plugin", {
			"mcp.json": {
				mcpServers: {
					existing: { command: "plugin-existing" },
					fresh: { command: "plugin-fresh" },
				},
			},
		});
		const configPath = getProjectMcpConfigPath(projectDir);
		writeJson(configPath, {
			settings: { toolPrefix: "server" },
			imports: ["cursor"],
			custom: true,
			mcpServers: {
				manual: { command: "manual" },
				"my-plugin__existing": { command: "user-existing" },
			},
		});

		const plugin = resolvePlugin(parseSource(`local:${pluginDir}`));
		const result = syncProjectMcpConfig(projectDir, [plugin]);
		const written = JSON.parse(readFileSync(configPath, "utf-8"));
		const sidecar = JSON.parse(readFileSync(getProjectMcpSidecarPath(projectDir), "utf-8"));

		expect(result.writtenCount).toBe(1);
		expect(result.warnings[0]).toContain("collides with an existing project MCP server");
		expect(written.settings).toEqual({ toolPrefix: "server" });
		expect(written.imports).toEqual(["cursor"]);
		expect(written.custom).toBe(true);
		expect(written.mcpServers.manual.command).toBe("manual");
		expect(written.mcpServers["my-plugin__existing"].command).toBe("user-existing");
		expect(written.mcpServers["my-plugin__fresh"].command).toBe("plugin-fresh");
		expect(sidecar.entries.map((entry: { name: string }) => entry.name)).toEqual(["my-plugin__fresh"]);

		syncProjectMcpConfig(projectDir, []);
		const cleaned = JSON.parse(readFileSync(configPath, "utf-8"));
		const cleanedSidecar = JSON.parse(readFileSync(getProjectMcpSidecarPath(projectDir), "utf-8"));

		expect(cleaned.mcpServers["my-plugin__fresh"]).toBeUndefined();
		expect(cleaned.mcpServers.manual.command).toBe("manual");
		expect(cleaned.mcpServers["my-plugin__existing"].command).toBe("user-existing");
		expect(cleanedSidecar.entries).toEqual([]);
	});
});

describe("extension MCP lifecycle", () => {
	it("warns and does not write MCP config when pi-mcp-adapter is absent", () => {
		const projectDir = join(tmpDir, "missing-adapter-project");
		const pluginDir = createPlugin("mcp-plugin", {
			"mcp.json": { mcpServers: { server: { command: "server" } } },
		});
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeJson(join(projectDir, ".pi", "settings.json"), {
			ccPlugins: [`local:${pluginDir}`],
		});
		const globalSettingsPath = join(tmpDir, "global-settings.json");
		writeJson(globalSettingsPath, {});

		const { mockPi, handlers } = createMockPi();
		extension(mockPi as any, { globalSettingsPath });

		const ctx = createMockCtx(projectDir);
		handlers["session_start"]({}, ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("pi-mcp-adapter is not installed"),
			"warning",
		);
		expect(existsSync(getProjectMcpConfigPath(projectDir))).toBe(false);
	});

	it("writes project-scoped MCP config when pi-mcp-adapter is installed", () => {
		const projectDir = join(tmpDir, "adapter-project");
		const pluginDir = createPlugin("MCP Plugin", {
			"mcp.json": { mcpServers: { browser: { command: "browser" } } },
		});
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeJson(join(projectDir, ".pi", "settings.json"), {
			ccPlugins: [`local:${pluginDir}`],
		});
		const globalSettingsPath = join(tmpDir, "global-settings.json");
		writeJson(globalSettingsPath, { packages: ["npm:pi-mcp-adapter"] });

		const { mockPi, handlers } = createMockPi();
		extension(mockPi as any, { globalSettingsPath });

		const ctx = createMockCtx(projectDir);
		handlers["session_start"]({}, ctx);

		const written = JSON.parse(readFileSync(getProjectMcpConfigPath(projectDir), "utf-8"));
		expect(written.mcpServers["mcp-plugin__browser"].command).toBe("browser");
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("1 MCP server(s)"),
			"info",
		);
	});
});
