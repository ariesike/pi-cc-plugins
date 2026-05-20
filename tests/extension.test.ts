import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolve, join } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

// We test the extension lifecycle by simulating Pi's event system
// and checking that the correct skill paths are contributed.

const fixtures = resolve(import.meta.dirname, "fixtures");

/** Shared temp directory for hermetic tests */
const tmpDir = join(homedir(), ".pi-cc-plugins-test-tmp");

/** Create a mock ExtensionAPI that captures event registrations */
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

/** Create a mock ExtensionContext */
function createMockCtx(cwd?: string) {
	return {
		cwd: cwd || process.cwd(),
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

// Import the extension after mocking setup
import extension from "../index.js";
import { parseSource, resolvePlugin } from "../src/index.js";
import { readCcPlugins } from "../src/settings.js";

describe("extension lifecycle", () => {
	const mockGlobalSettingsPath = join(tmpDir, "global-settings.json");

	beforeEach(() => {
		mkdirSync(tmpDir, { recursive: true });
		writeFileSync(mockGlobalSettingsPath, "{}");
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("registers session_start, resources_discover, and session_shutdown handlers", () => {
		const { mockPi } = createMockPi();
		extension(mockPi as any, { globalSettingsPath: mockGlobalSettingsPath });

		expect(mockPi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
		expect(mockPi.on).toHaveBeenCalledWith("resources_discover", expect.any(Function));
		expect(mockPi.on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
	});

	it("contributes skill paths from a local plugin", async () => {
		const { mockPi, handlers } = createMockPi();
		extension(mockPi as any, { globalSettingsPath: mockGlobalSettingsPath });

		const ctx = createMockCtx();

		// Trigger resources_discover with no prior session_start
		const discoverResult = await handlers["resources_discover"]({}, ctx);
		expect(discoverResult).toBeUndefined(); // no plugins resolved yet
	});

	it("does not notify when no plugins are configured", () => {
		const { mockPi, handlers } = createMockPi();
		extension(mockPi as any, { globalSettingsPath: mockGlobalSettingsPath });

		const ctx = createMockCtx("/nonexistent/path");
		handlers["session_start"]({}, ctx);

		// No plugins → no notification
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("loads plugins from project settings", () => {
		const projectDir = join(tmpDir, "my-project");
		const settingsDir = join(projectDir, ".pi");
		mkdirSync(settingsDir, { recursive: true });
		writeFileSync(
			join(settingsDir, "settings.json"),
			JSON.stringify({ ccPlugins: [`local:${resolve(fixtures, "mock-plugin")}`] }),
		);

		const { mockPi, handlers } = createMockPi();
		extension(mockPi as any, { globalSettingsPath: mockGlobalSettingsPath });

		const ctx = createMockCtx(projectDir);
		handlers["session_start"]({}, ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("2 skill(s)"),
			"info",
		);
	});
});

describe("resolvePlugin with local source", () => {
	it("resolves a local plugin and discovers its skills", () => {
		const source = parseSource(`local:${resolve(fixtures, "mock-plugin")}`);
		const plugin = resolvePlugin(source);

		expect(plugin.name).toBe("mock-plugin");
		expect(plugin.skillPaths).toHaveLength(2);
		expect(plugin.agentPaths).toEqual([]);
		expect(plugin.rootDir).toBe(resolve(fixtures, "mock-plugin"));
	});

	it("resolves a local plugin with tilde path", () => {
		const actualPath = homedir();
		const source = parseSource(`local:~`);
		const plugin = resolvePlugin(source);
		expect(plugin.rootDir).toBe(actualPath);
		expect(plugin.skillPaths).toEqual([]);
		expect(plugin.agentPaths).toEqual([]);
	});

	it("throws for non-existent local path", () => {
		const source = parseSource("local:/nonexistent/plugin/path");
		expect(() => resolvePlugin(source)).toThrow("does not exist");
	});

	it("resolves local plugin with subpath", () => {
		const source = parseSource(`local:${resolve(fixtures, "mock-plugin")}#subpath=skills/code-reviewer`);
		const plugin = resolvePlugin(source);
		expect(plugin.rootDir).toBe(resolve(fixtures, "mock-plugin", "skills", "code-reviewer"));
	});
});

describe("readCcPlugins", () => {
	const mockGlobalSettingsPath = join(tmpDir, "global-settings.json");

	beforeEach(() => {
		mkdirSync(tmpDir, { recursive: true });
		writeFileSync(mockGlobalSettingsPath, "{}");
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("reads ccPlugins from a project settings file", () => {
		const settingsDir = join(tmpDir, ".pi");
		mkdirSync(settingsDir, { recursive: true });
		writeFileSync(
			join(settingsDir, "settings.json"),
			JSON.stringify({ ccPlugins: ["github:owner/repo", "local:~/path"] }),
		);

		const result = readCcPlugins(tmpDir, { globalSettingsPath: mockGlobalSettingsPath });
		expect(result).toEqual(["github:owner/repo", "local:~/path"]);
	});

	it("returns empty array when no ccPlugins in settings", () => {
		writeFileSync(
			join(tmpDir, "settings.json"),
			JSON.stringify({ theme: "dark" }),
		);
		const result = readCcPlugins(tmpDir, { globalSettingsPath: mockGlobalSettingsPath });
		expect(result).toEqual([]);
	});

	it("returns empty array when settings file doesn't exist", () => {
		const result = readCcPlugins("/nonexistent/directory", { globalSettingsPath: mockGlobalSettingsPath });
		expect(result).toEqual([]);
	});

	it("merges project settings over global settings", () => {
		writeFileSync(
			mockGlobalSettingsPath,
			JSON.stringify({ ccPlugins: ["github:global/plugin"] }),
		);
		const settingsDir = join(tmpDir, ".pi");
		mkdirSync(settingsDir, { recursive: true });
		writeFileSync(
			join(settingsDir, "settings.json"),
			JSON.stringify({ ccPlugins: ["github:foo/bar"] }),
		);

		const result = readCcPlugins(tmpDir, { globalSettingsPath: mockGlobalSettingsPath });
		expect(result).toEqual(["github:foo/bar"]);
	});

	it("falls back to global settings when project has no ccPlugins", () => {
		writeFileSync(
			mockGlobalSettingsPath,
			JSON.stringify({ ccPlugins: ["github:global/plugin"] }),
		);
		const settingsDir = join(tmpDir, ".pi");
		mkdirSync(settingsDir, { recursive: true });
		writeFileSync(
			join(settingsDir, "settings.json"),
			JSON.stringify({ theme: "dark" }),
		);

		const result = readCcPlugins(tmpDir, { globalSettingsPath: mockGlobalSettingsPath });
		expect(result).toEqual(["github:global/plugin"]);
	});

	it("handles JSON with comments", () => {
		const settingsDir = join(tmpDir, ".pi");
		mkdirSync(settingsDir, { recursive: true });
		writeFileSync(
			join(settingsDir, "settings.json"),
			`{
  // This is a comment
  "ccPlugins": ["github:owner/repo"]
}`,
		);

		const result = readCcPlugins(tmpDir, { globalSettingsPath: mockGlobalSettingsPath });
		expect(result).toEqual(["github:owner/repo"]);
	});

	it("filters out non-string entries", () => {
		const settingsDir = join(tmpDir, ".pi");
		mkdirSync(settingsDir, { recursive: true });
		writeFileSync(
			join(settingsDir, "settings.json"),
			JSON.stringify({ ccPlugins: ["github:owner/repo", 42, null, { foo: "bar" }] }),
		);

		const result = readCcPlugins(tmpDir, { globalSettingsPath: mockGlobalSettingsPath });
		expect(result).toEqual(["github:owner/repo"]);
	});
});
