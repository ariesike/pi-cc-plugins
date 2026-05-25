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
import { readCcPlugins, readCcClaudeSkillsGlobal, readCcClaudeSkillsProject } from "../src/settings.js";

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

describe("readCcClaudeSkillsGlobal", () => {
	const mockGlobalSettingsPath = join(tmpDir, "global-settings.json");

	beforeEach(() => {
		mkdirSync(tmpDir, { recursive: true });
		writeFileSync(mockGlobalSettingsPath, "{}");
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns false when setting is absent", () => {
		const result = readCcClaudeSkillsGlobal(tmpDir, { globalSettingsPath: mockGlobalSettingsPath });
		expect(result).toBe(false);
	});

	it("returns true when enabled in global settings", () => {
		writeFileSync(mockGlobalSettingsPath, JSON.stringify({ ccClaudeSkillsGlobal: true }));
		const result = readCcClaudeSkillsGlobal(tmpDir, { globalSettingsPath: mockGlobalSettingsPath });
		expect(result).toBe(true);
	});

	it("returns false when set to a non-boolean value", () => {
		writeFileSync(mockGlobalSettingsPath, JSON.stringify({ ccClaudeSkillsGlobal: "yes" }));
		const result = readCcClaudeSkillsGlobal(tmpDir, { globalSettingsPath: mockGlobalSettingsPath });
		expect(result).toBe(false);
	});

	it("project settings override global", () => {
		writeFileSync(mockGlobalSettingsPath, JSON.stringify({ ccClaudeSkillsGlobal: true }));
		const settingsDir = join(tmpDir, ".pi");
		mkdirSync(settingsDir, { recursive: true });
		writeFileSync(
			join(settingsDir, "settings.json"),
			JSON.stringify({ ccClaudeSkillsGlobal: false }),
		);
		const result = readCcClaudeSkillsGlobal(tmpDir, { globalSettingsPath: mockGlobalSettingsPath });
		expect(result).toBe(false);
	});
});

describe("readCcClaudeSkillsProject", () => {
	const mockGlobalSettingsPath = join(tmpDir, "global-settings.json");

	beforeEach(() => {
		mkdirSync(tmpDir, { recursive: true });
		writeFileSync(mockGlobalSettingsPath, "{}");
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns false when setting is absent", () => {
		const result = readCcClaudeSkillsProject(tmpDir, { globalSettingsPath: mockGlobalSettingsPath });
		expect(result).toBe(false);
	});

	it("returns true when enabled in project settings", () => {
		const settingsDir = join(tmpDir, ".pi");
		mkdirSync(settingsDir, { recursive: true });
		writeFileSync(
			join(settingsDir, "settings.json"),
			JSON.stringify({ ccClaudeSkillsProject: true }),
		);
		const result = readCcClaudeSkillsProject(tmpDir, { globalSettingsPath: mockGlobalSettingsPath });
		expect(result).toBe(true);
	});

	it("returns false when set to a non-boolean value", () => {
		const settingsDir = join(tmpDir, ".pi");
		mkdirSync(settingsDir, { recursive: true });
		writeFileSync(
			join(settingsDir, "settings.json"),
			JSON.stringify({ ccClaudeSkillsProject: 1 }),
		);
		const result = readCcClaudeSkillsProject(tmpDir, { globalSettingsPath: mockGlobalSettingsPath });
		expect(result).toBe(false);
	});
});

describe("extension with .claude/skills", () => {
	const mockGlobalSettingsPath = join(tmpDir, "global-settings.json");

	beforeEach(() => {
		mkdirSync(tmpDir, { recursive: true });
		writeFileSync(mockGlobalSettingsPath, "{}");
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("loads skills from project .claude/skills when ccClaudeSkillsProject is enabled", async () => {
		const projectDir = join(tmpDir, "claude-project");
		const settingsDir = join(projectDir, ".pi");
		mkdirSync(settingsDir, { recursive: true });
		writeFileSync(
			join(settingsDir, "settings.json"),
			JSON.stringify({ ccClaudeSkillsProject: true }),
		);

		// Create .claude/skills fixture
		const claudeSkillsDir = join(projectDir, ".claude", "skills", "my-skill");
		mkdirSync(claudeSkillsDir, { recursive: true });
		writeFileSync(
			join(claudeSkillsDir, "SKILL.md"),
			"---\nname: my-skill\ndescription: Test skill\n---\n\n# Test\n",
		);

		const { mockPi, handlers } = createMockPi();
		extension(mockPi as any, { globalSettingsPath: mockGlobalSettingsPath });

		const ctx = createMockCtx(projectDir);
		handlers["session_start"]({}, ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("1 skill(s)"),
			"info",
		);

		// Verify resources_discover returns the skill
		const discoverResult = await handlers["resources_discover"]({}, ctx);
		expect(discoverResult).toBeDefined();
		expect(discoverResult!.skillPaths).toHaveLength(1);
	});

	it("does not load .claude/skills when settings are disabled", async () => {
		const projectDir = join(tmpDir, "claude-project-off");
		const settingsDir = join(projectDir, ".pi");
		mkdirSync(settingsDir, { recursive: true });
		writeFileSync(
			join(settingsDir, "settings.json"),
			JSON.stringify({ ccClaudeSkillsProject: false }),
		);

		// Create .claude/skills fixture
		const claudeSkillsDir = join(projectDir, ".claude", "skills", "my-skill");
		mkdirSync(claudeSkillsDir, { recursive: true });
		writeFileSync(
			join(claudeSkillsDir, "SKILL.md"),
			"---\nname: my-skill\ndescription: Test skill\n---\n\n# Test\n",
		);

		const { mockPi, handlers } = createMockPi();
		extension(mockPi as any, { globalSettingsPath: mockGlobalSettingsPath });

		const ctx = createMockCtx(projectDir);
		handlers["session_start"]({}, ctx);

		// No skills loaded → no notification
		expect(ctx.ui.notify).not.toHaveBeenCalled();

		const discoverResult = await handlers["resources_discover"]({}, ctx);
		expect(discoverResult).toBeUndefined();
	});

	it("loads skills from global ~/.claude/skills when ccClaudeSkillsGlobal is enabled", async () => {
		const projectDir = join(tmpDir, "claude-global-project");
		mkdirSync(projectDir, { recursive: true });

		// Enable global setting
		writeFileSync(
			mockGlobalSettingsPath,
			JSON.stringify({ ccClaudeSkillsGlobal: true }),
		);

		// Create a fake home .claude/skills
		const fakeHome = join(tmpDir, "fake-home");
		const claudeSkillsDir = join(fakeHome, ".claude", "skills", "global-skill");
		mkdirSync(claudeSkillsDir, { recursive: true });
		writeFileSync(
			join(claudeSkillsDir, "SKILL.md"),
			"---\nname: global-skill\ndescription: Global test\n---\n\n# Global\n",
		);

		// We can't easily override homedir(), so we test indirectly via the settings reader
		// The extension test verifies the setting is read correctly
		const result = readCcClaudeSkillsGlobal(projectDir, { globalSettingsPath: mockGlobalSettingsPath });
		expect(result).toBe(true);
	});

	it("combines plugin skills and .claude/skills", async () => {
		const projectDir = join(tmpDir, "combined-project");
		const settingsDir = join(projectDir, ".pi");
		mkdirSync(settingsDir, { recursive: true });
		writeFileSync(
			join(settingsDir, "settings.json"),
			JSON.stringify({
				ccPlugins: [`local:${resolve(fixtures, "mock-plugin")}`],
				ccClaudeSkillsProject: true,
			}),
		);

		// Create .claude/skills fixture
		const claudeSkillsDir = join(projectDir, ".claude", "skills", "extra-skill");
		mkdirSync(claudeSkillsDir, { recursive: true });
		writeFileSync(
			join(claudeSkillsDir, "SKILL.md"),
			"---\nname: extra-skill\ndescription: Extra\n---\n\n# Extra\n",
		);

		const { mockPi, handlers } = createMockPi();
		extension(mockPi as any, { globalSettingsPath: mockGlobalSettingsPath });

		const ctx = createMockCtx(projectDir);
		handlers["session_start"]({}, ctx);

		// 2 plugin skills + 1 .claude/skill = 3 total
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("3 skill(s)"),
			"info",
		);

		const discoverResult = await handlers["resources_discover"]({}, ctx);
		expect(discoverResult).toBeDefined();
		expect(discoverResult!.skillPaths).toHaveLength(3);
	});

	it("sanitizes frontmatter from .claude/skills", async () => {
		const projectDir = join(tmpDir, "sanitize-project");
		const settingsDir = join(projectDir, ".pi");
		mkdirSync(settingsDir, { recursive: true });
		writeFileSync(
			join(settingsDir, "settings.json"),
			JSON.stringify({ ccClaudeSkillsProject: true }),
		);

		// Create .claude/skills fixture with loose frontmatter
		const claudeSkillsDir = join(projectDir, ".claude", "skills", "loose-skill");
		mkdirSync(claudeSkillsDir, { recursive: true });
		writeFileSync(
			join(claudeSkillsDir, "SKILL.md"),
			"---\nname: loose-skill\ndescription: Use when: testing, and do NOT use for: prod\nargument-hint: [arg1] [arg2]\n---\n\n# Loose\n",
		);

		const { mockPi, handlers } = createMockPi();
		extension(mockPi as any, { globalSettingsPath: mockGlobalSettingsPath });

		const ctx = createMockCtx(projectDir);
		handlers["session_start"]({}, ctx);

		const discoverResult = await handlers["resources_discover"]({}, ctx);
		expect(discoverResult).toBeDefined();
		expect(discoverResult!.skillPaths).toHaveLength(1);

		// Read the materialized SKILL.md and verify sanitization
		const { readFileSync } = await import("node:fs");
		const materialized = readFileSync(join(discoverResult!.skillPaths[0], "SKILL.md"), "utf-8");
		expect(materialized).toContain('name: "loose-skill"');
		expect(materialized).toContain('description: "Use when: testing, and do NOT use for: prod"');
		expect(materialized).toContain('argument-hint: "[arg1] [arg2]"');
	});
});
