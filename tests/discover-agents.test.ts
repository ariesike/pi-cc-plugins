import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve, join } from "node:path";
import { mkdirSync, rmSync, writeFileSync, existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

import {
	discoverAgentPaths,
} from "../src/plugin.js";
import {
	parseFrontmatter,
	parseCcAgent,
	convertCcAgent,
	writeCachedAgent,
	linkAgents,
	unlinkAgents,
	incrementRefcount,
	decrementRefcount,
	cleanupStaleSymlinks,
	isSubagentsInstalled,
	getAgentCacheBaseDir,
	CC_AGENTS_LINK_DIR,
} from "../src/agents.js";

const fixtures = resolve(import.meta.dirname, "fixtures");
const tmpDir = join(homedir(), ".pi-cc-plugins-agents-test-tmp");

beforeEach(() => {
	mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// discoverAgentPaths
// ---------------------------------------------------------------------------

describe("discoverAgentPaths", () => {
	it("discovers agents from a plugin with agents/", () => {
		const pluginDir = resolve(fixtures, "mock-plugin-with-agents");
		const paths = discoverAgentPaths(pluginDir);

		expect(paths).toHaveLength(2);
		expect(paths.some((p) => p.endsWith("code-reviewer.md"))).toBe(true);
		expect(paths.some((p) => p.endsWith("debug-helper.md"))).toBe(true);
	});

	it("returns empty array when plugin has no agents/", () => {
		const pluginDir = resolve(fixtures, "mock-plugin");
		const paths = discoverAgentPaths(pluginDir);
		expect(paths).toEqual([]);
	});

	it("returns empty array when plugin has no agents directory", () => {
		const pluginDir = resolve(fixtures, "mock-plugin-no-skills");
		const paths = discoverAgentPaths(pluginDir);
		expect(paths).toEqual([]);
	});

	it("returns empty array for a non-existent directory", () => {
		const paths = discoverAgentPaths("/non/existent/path");
		expect(paths).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// parseFrontmatter
// ---------------------------------------------------------------------------

describe("parseFrontmatter", () => {
	it("parses simple YAML frontmatter", () => {
		const content = `---
name: test-agent
description: A test
---

Body text here.`;

		const { frontmatter, body } = parseFrontmatter(content);
		expect(frontmatter.name).toBe("test-agent");
		expect(frontmatter.description).toBe("A test");
		expect(body).toBe("Body text here.");
	});

	it("parses frontmatter with multiple fields", () => {
		const content = `---
name: agent
description: Desc
model: sonnet
tools: read, bash
skills: code-review
---

Prompt.`;

		const { frontmatter, body } = parseFrontmatter(content);
		expect(frontmatter.name).toBe("agent");
		expect(frontmatter.description).toBe("Desc");
		expect(frontmatter.model).toBe("sonnet");
		expect(frontmatter.tools).toBe("read, bash");
		expect(frontmatter.skills).toBe("code-review");
		expect(body).toBe("Prompt.");
	});

	it("returns empty frontmatter when no --- delimiters", () => {
		const content = "Just a body with no frontmatter.";
		const { frontmatter, body } = parseFrontmatter(content);
		expect(frontmatter).toEqual({});
		expect(body).toBe("Just a body with no frontmatter.");
	});

	it("returns empty frontmatter when no closing ---", () => {
		const content = "---\nname: agent\nNo closing delimiter";
		const { frontmatter, body } = parseFrontmatter(content);
		expect(frontmatter).toEqual({});
	});
});

// ---------------------------------------------------------------------------
// parseCcAgent
// ---------------------------------------------------------------------------

describe("parseCcAgent", () => {
	it("parses a complete CC agent file", () => {
		const agentPath = resolve(fixtures, "mock-plugin-with-agents", "agents", "code-reviewer.md");
		const agent = parseCcAgent(agentPath);

		expect(agent).not.toBeNull();
		expect(agent!.name).toBe("code-reviewer");
		expect(agent!.description).toBe("Reviews code for quality, security, and best practices");
		expect(agent!.model).toBe("sonnet");
		expect(agent!.tools).toBe("read, grep, find, ls");
		expect(agent!.skills).toBe("code-review");
		expect(agent!.systemPrompt).toContain("You are a code reviewer");
		expect(agent!.filePath).toBe(agentPath);
	});

	it("parses a minimal agent with only name and description", () => {
		const agentPath = resolve(fixtures, "mock-plugin-with-agents", "agents", "debug-helper.md");
		const agent = parseCcAgent(agentPath);

		expect(agent).not.toBeNull();
		expect(agent!.name).toBe("debug-helper");
		expect(agent!.description).toBe("Helps debug issues by analyzing logs and stack traces");
		expect(agent!.model).toBeUndefined();
		expect(agent!.tools).toBeUndefined();
		expect(agent!.skills).toBeUndefined();
	});

	it("returns null for agent missing description", () => {
		const agentPath = resolve(fixtures, "mock-plugin-agents-incomplete", "agents", "bad-agent.md");
		const agent = parseCcAgent(agentPath);
		expect(agent).toBeNull();
	});

	it("returns null for non-existent file", () => {
		const agent = parseCcAgent("/nonexistent/agent.md");
		expect(agent).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// convertCcAgent
// ---------------------------------------------------------------------------

describe("convertCcAgent", () => {
	it("converts a CC agent to pi-subagents format", () => {
		const agent = {
			name: "code-reviewer",
			description: "Reviews code",
			model: "sonnet",
			tools: "read, grep",
			skills: "code-review",
			systemPrompt: "You are a reviewer.",
			filePath: "/fake/path.md",
		};

		const result = convertCcAgent(agent, "my-plugin");
		expect(result).toContain("name: code-reviewer");
		expect(result).toContain("package: my-plugin");
		expect(result).toContain("description: Reviews code");
		expect(result).toContain("model: sonnet");
		expect(result).toContain("tools: read, grep");
		expect(result).toContain("skills: code-review");
		expect(result).toContain("systemPromptMode: append");
		expect(result).toContain("inheritProjectContext: true");
		expect(result).toContain("inheritSkills: true");
		expect(result).toContain("You are a reviewer.");
	});

	it("omits optional fields when not provided", () => {
		const agent = {
			name: "minimal",
			description: "Minimal agent",
			systemPrompt: "Do stuff.",
			filePath: "/fake/path.md",
		};

		const result = convertCcAgent(agent, "test-plugin");
		expect(result).toContain("name: minimal");
		expect(result).toContain("package: test-plugin");
		expect(result).not.toContain("model:");
		expect(result).not.toContain("tools:");
		expect(result).not.toContain("skills:");
		expect(result).toContain("Do stuff.");
	});

	it("includes system prompt body", () => {
		const agent = {
			name: "agent",
			description: "Desc",
			systemPrompt: "Line 1\nLine 2\nLine 3",
			filePath: "/fake/path.md",
		};

		const result = convertCcAgent(agent, "pkg");
		expect(result).toContain("Line 1\nLine 2\nLine 3");
	});
});

// ---------------------------------------------------------------------------
// writeCachedAgent
// ---------------------------------------------------------------------------

describe("writeCachedAgent", () => {
	it("writes converted agent to cache directory", () => {
		const cachedPath = writeCachedAgent("test-slug", "my-agent", "content here");
		expect(existsSync(cachedPath)).toBe(true);
		expect(readFileSync(cachedPath, "utf-8")).toBe("content here");
	});

	it("sanitizes agent name for filesystem", () => {
		const cachedPath = writeCachedAgent("slug", "My Cool Agent!", "body");
		expect(cachedPath).toContain("my-cool-agent-.md");
		expect(existsSync(cachedPath)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Symlink management with reference counting
// ---------------------------------------------------------------------------

describe("reference counting and symlinks", () => {
	const projectRoot = join(tmpDir, "test-project");

	it("increments refcount from 0 to 1", () => {
		const count = incrementRefcount(projectRoot);
		expect(count).toBe(1);

		// Verify the refcount file exists
		const refPath = join(projectRoot, CC_AGENTS_LINK_DIR, ".cc-plugins-refcount");
		expect(existsSync(refPath)).toBe(true);
		expect(readFileSync(refPath, "utf-8").trim()).toBe("1");
	});

	it("increments and decrements refcount", () => {
		incrementRefcount(projectRoot);
		incrementRefcount(projectRoot);
		expect(readFileSync(join(projectRoot, CC_AGENTS_LINK_DIR, ".cc-plugins-refcount"), "utf-8").trim()).toBe("2");

		const count = decrementRefcount(projectRoot);
		expect(count).toBe(1);

		// Directory should still exist
		expect(existsSync(join(projectRoot, CC_AGENTS_LINK_DIR))).toBe(true);
	});

	it("removes directory when refcount reaches 0", () => {
		incrementRefcount(projectRoot);
		expect(existsSync(join(projectRoot, CC_AGENTS_LINK_DIR))).toBe(true);

		const count = decrementRefcount(projectRoot);
		expect(count).toBe(0);
		expect(existsSync(join(projectRoot, CC_AGENTS_LINK_DIR))).toBe(false);
	});

	it("creates symlinks to cached agents", () => {
		incrementRefcount(projectRoot);

		// Write a cached agent file
		const cachedPath = writeCachedAgent("test-slug", "reviewer", "converted content");

		linkAgents(projectRoot, [
			{ pluginName: "test-plugin", agentName: "reviewer", cachedPath },
		]);

		const linkPath = join(projectRoot, CC_AGENTS_LINK_DIR, "test-plugin--reviewer.md");
		expect(existsSync(linkPath)).toBe(true);
		expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
		expect(readFileSync(linkPath, "utf-8")).toBe("converted content");
	});

	it("cleans up symlinks on decrement to 0", () => {
		incrementRefcount(projectRoot);

		const cachedPath = writeCachedAgent("slug", "agent", "body");
		linkAgents(projectRoot, [
			{ pluginName: "plug", agentName: "agent", cachedPath },
		]);

		expect(existsSync(join(projectRoot, CC_AGENTS_LINK_DIR, "plug--agent.md"))).toBe(true);

		decrementRefcount(projectRoot);
		expect(existsSync(join(projectRoot, CC_AGENTS_LINK_DIR))).toBe(false);
	});

	it("cleans up stale symlinks for removed plugins", () => {
		incrementRefcount(projectRoot);

		const cachedA = writeCachedAgent("a", "reviewer", "a-content");
		const cachedB = writeCachedAgent("b", "planner", "b-content");

		linkAgents(projectRoot, [
			{ pluginName: "plugin-a", agentName: "reviewer", cachedPath: cachedA },
			{ pluginName: "plugin-b", agentName: "planner", cachedPath: cachedB },
		]);

		// Only plugin-a is current now
		cleanupStaleSymlinks(projectRoot, new Set(["plugin-a"]));

		// plugin-a symlink should remain
		expect(existsSync(join(projectRoot, CC_AGENTS_LINK_DIR, "plugin-a--reviewer.md"))).toBe(true);
		// plugin-b symlink should be removed
		expect(existsSync(join(projectRoot, CC_AGENTS_LINK_DIR, "plugin-b--planner.md"))).toBe(false);
		// refcount file should remain
		expect(existsSync(join(projectRoot, CC_AGENTS_LINK_DIR, ".cc-plugins-refcount"))).toBe(true);

		// Clean up
		decrementRefcount(projectRoot);
	});

	it("replaces existing symlink on re-link", () => {
		incrementRefcount(projectRoot);

		const cachedV1 = writeCachedAgent("slug", "agent", "v1");
		const cachedV2 = join(tmpDir, "v2-agent.md");
		writeFileSync(cachedV2, "v2");

		linkAgents(projectRoot, [
			{ pluginName: "plug", agentName: "agent", cachedPath: cachedV1 },
		]);

		// Re-link with new version
		linkAgents(projectRoot, [
			{ pluginName: "plug", agentName: "agent", cachedPath: cachedV2 },
		]);

		const linkPath = join(projectRoot, CC_AGENTS_LINK_DIR, "plug--agent.md");
		expect(readFileSync(linkPath, "utf-8")).toBe("v2");

		decrementRefcount(projectRoot);
	});
});

// ---------------------------------------------------------------------------
// isSubagentsInstalled
// ---------------------------------------------------------------------------

describe("isSubagentsInstalled", () => {
	it("returns a boolean (depends on real settings)", () => {
		// This reads the real user settings — just verify it doesn't throw
		const result = isSubagentsInstalled();
		expect(typeof result).toBe("boolean");
	});
});
