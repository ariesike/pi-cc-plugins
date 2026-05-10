import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { discoverSkillPaths, readPluginName } from "../index.js";

const fixtures = resolve(import.meta.dirname, "fixtures");

describe("discoverSkillPaths", () => {
	it("discovers skills from a standard plugin layout", () => {
		const pluginDir = resolve(fixtures, "mock-plugin");
		const paths = discoverSkillPaths(pluginDir);

		expect(paths).toHaveLength(2);
		expect(paths).toContain(resolve(pluginDir, "skills", "code-reviewer"));
		expect(paths).toContain(resolve(pluginDir, "skills", "pdf-processor"));
	});

	it("discovers skills from a plugin without a manifest", () => {
		const pluginDir = resolve(fixtures, "mock-plugin-no-manifest");
		const paths = discoverSkillPaths(pluginDir);

		expect(paths).toHaveLength(1);
		expect(paths).toContain(resolve(pluginDir, "skills", "greeter"));
	});

	it("uses custom skills path from plugin.json", () => {
		const pluginDir = resolve(fixtures, "mock-plugin-custom-skills");
		const paths = discoverSkillPaths(pluginDir);

		expect(paths).toHaveLength(1);
		expect(paths).toContain(resolve(pluginDir, "custom-dir", "deep-reviewer"));
	});

	it("returns empty array when plugin has no skills directory", () => {
		const pluginDir = resolve(fixtures, "mock-plugin-no-skills");
		const paths = discoverSkillPaths(pluginDir);

		expect(paths).toEqual([]);
	});

	it("returns empty array for a non-existent directory", () => {
		const paths = discoverSkillPaths("/non/existent/path");
		expect(paths).toEqual([]);
	});
});

describe("readPluginName", () => {
	it("reads name from .claude-plugin/plugin.json", () => {
		const pluginDir = resolve(fixtures, "mock-plugin");
		expect(readPluginName(pluginDir)).toBe("mock-plugin");
	});

	it("falls back to directory name when no manifest exists", () => {
		const pluginDir = resolve(fixtures, "mock-plugin-no-manifest");
		expect(readPluginName(pluginDir)).toBe("mock-plugin-no-manifest");
	});

	it("falls back to directory name when manifest has no name", () => {
		const pluginDir = resolve(fixtures, "mock-plugin-custom-skills");
		expect(readPluginName(pluginDir)).toBe("custom-skills-plugin");
	});
});
