/**
 * Agent discovery, format conversion, caching, and symlink management.
 *
 * Discovers Claude Code plugin agents, converts them to pi-subagents format,
 * caches the converted files, and manages symlinks in the project's
 * .pi/agents/cc-plugins/ directory.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, symlinkSync, readdirSync, rmSync, statSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getCacheBaseDir } from "./cache.js";
import { readJsonFile } from "./settings.js";
import type { ParsedAgent } from "./types.js";

// ---------------------------------------------------------------------------
// Frontmatter parsing
// ---------------------------------------------------------------------------

/**
 * Parse YAML frontmatter from a markdown string.
 * Returns { frontmatter, body } where frontmatter is a flat key-value map
 * and body is everything after the closing ---.
 */
export function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
	const trimmed = content.trimStart();

	// Must start with ---
	if (!trimmed.startsWith("---")) {
		return { frontmatter: {}, body: content };
	}

	// Find the closing ---
	const afterFirst = trimmed.slice(3);
	const closeIdx = afterFirst.indexOf("\n---");
	if (closeIdx === -1) {
		return { frontmatter: {}, body: content };
	}

	const yamlBlock = afterFirst.slice(0, closeIdx);
	const body = afterFirst.slice(closeIdx + 4).trim();

	const frontmatter: Record<string, string> = {};
	for (const line of yamlBlock.split("\n")) {
		const colonIdx = line.indexOf(":");
		if (colonIdx === -1) continue;
		const key = line.slice(0, colonIdx).trim();
		const value = line.slice(colonIdx + 1).trim();
		if (key) frontmatter[key] = value;
	}

	return { frontmatter, body };
}

// ---------------------------------------------------------------------------
// Agent parsing
// ---------------------------------------------------------------------------

/**
 * Parse a Claude Code plugin agent .md file.
 * Returns null if the file doesn't have required fields (name, description).
 */
export function parseCcAgent(filePath: string): ParsedAgent | null {
	let content: string;
	try {
		content = readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}

	const { frontmatter, body } = parseFrontmatter(content);

	if (!frontmatter.name || !frontmatter.description) {
		return null;
	}

	return {
		name: frontmatter.name,
		description: frontmatter.description,
		model: frontmatter.model || undefined,
		tools: frontmatter.tools || undefined,
		skills: frontmatter.skills || undefined,
		systemPrompt: body,
		filePath,
	};
}

// ---------------------------------------------------------------------------
// Format conversion
// ---------------------------------------------------------------------------

/**
 * Convert a parsed Claude Code agent to pi-subagents markdown format.
 * Generates a complete .md file with pi-subagents YAML frontmatter.
 */
export function convertCcAgent(agent: ParsedAgent, pluginName: string): string {
	const lines: string[] = ["---"];

	// Name: use the CC agent name directly
	lines.push(`name: ${agent.name}`);

	// Package: namespace with plugin name to avoid collisions
	lines.push(`package: ${pluginName}`);

	// Description
	lines.push(`description: ${agent.description}`);

	// Model: pass through as-is
	if (agent.model) {
		lines.push(`model: ${agent.model}`);
	}

	// Tools: pass through allowlist if specified
	if (agent.tools) {
		lines.push(`tools: ${agent.tools}`);
	}

	// Skills: pass through if specified
	if (agent.skills) {
		lines.push(`skills: ${agent.skills}`);
	}

	// Defaults for pi-subagents
	lines.push("systemPromptMode: append");
	lines.push("inheritProjectContext: true");
	lines.push("inheritSkills: true");

	lines.push("---");
	lines.push("");

	// System prompt body
	if (agent.systemPrompt) {
		lines.push(agent.systemPrompt);
	}

	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Cache management
// ---------------------------------------------------------------------------

/** Base directory for cached converted agents */
export function getAgentCacheBaseDir(): string {
	return join(getCacheBaseDir(), "agents");
}

/**
 * Write a converted agent to the cache directory.
 * Returns the absolute path of the cached file.
 */
export function writeCachedAgent(pluginSlug: string, agentName: string, content: string): string {
	const cacheDir = join(getAgentCacheBaseDir(), pluginSlug);
	mkdirSync(cacheDir, { recursive: true });

	// Sanitize agent name for filesystem
	const safeName = agentName.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");
	const cachedPath = join(cacheDir, `${safeName}.md`);

	writeFileSync(cachedPath, content, "utf-8");
	return cachedPath;
}

// ---------------------------------------------------------------------------
// Symlink management with reference counting
// ---------------------------------------------------------------------------

/** Relative path within the project for cc-plugins agent symlinks */
export const CC_AGENTS_LINK_DIR = ".pi/agents/cc-plugins";

/** Filename for the reference count file */
const REFCOUNT_FILE = ".cc-plugins-refcount";

/**
 * Get the absolute path to the cc-plugins agents directory for a project.
 */
export function getAgentsLinkDir(projectRoot: string): string {
	return join(projectRoot, CC_AGENTS_LINK_DIR);
}

/**
 * Read the current reference count. Returns 0 if file doesn't exist.
 */
function readRefcount(projectRoot: string): number {
	const refPath = join(getAgentsLinkDir(projectRoot), REFCOUNT_FILE);
	if (!existsSync(refPath)) return 0;
	try {
		const content = readFileSync(refPath, "utf-8").trim();
		const count = Number.parseInt(content, 10);
		return Number.isNaN(count) ? 0 : count;
	} catch {
		return 0;
	}
}

/**
 * Write the reference count to disk.
 */
function writeRefcount(projectRoot: string, count: number): void {
	const dir = getAgentsLinkDir(projectRoot);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, REFCOUNT_FILE), String(count), "utf-8");
}

/**
 * Increment the reference count for a project. Returns the new count.
 */
export function incrementRefcount(projectRoot: string): number {
	const count = readRefcount(projectRoot) + 1;
	writeRefcount(projectRoot, count);
	return count;
}

/**
 * Decrement the reference count for a project. Returns the new count.
 * If count reaches 0, removes all symlinks and the cc-plugins directory.
 */
export function decrementRefcount(projectRoot: string): number {
	const current = readRefcount(projectRoot);
	const count = Math.max(0, current - 1);

	if (count === 0) {
		// Remove all symlinks and the directory
		const dir = getAgentsLinkDir(projectRoot);
		if (existsSync(dir)) {
			rmSync(dir, { recursive: true, force: true });
		}
		// Also try to clean up .pi/agents/ if empty
		const agentsDir = join(projectRoot, ".pi", "agents");
		try {
			if (existsSync(agentsDir) && readdirSync(agentsDir).length === 0) {
				rmSync(agentsDir, { recursive: true, force: true });
			}
		} catch {
			// Ignore cleanup failures
		}
		// Also try to clean up .pi/ if empty
		const piDir = join(projectRoot, ".pi");
		try {
			if (existsSync(piDir) && readdirSync(piDir).length === 0) {
				rmSync(piDir, { recursive: true, force: true });
			}
		} catch {
			// Ignore cleanup failures
		}
	} else {
		writeRefcount(projectRoot, count);
	}

	return count;
}

/**
 * Remove stale symlinks — those whose prefix (plugin name) doesn't match
 * any of the currently configured plugin names.
 */
export function cleanupStaleSymlinks(projectRoot: string, currentPluginNames: Set<string>): void {
	const dir = getAgentsLinkDir(projectRoot);
	if (!existsSync(dir)) return;

	let entries;
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}

	for (const entry of entries) {
		// Skip the refcount file
		if (entry === REFCOUNT_FILE) continue;

		const fullPath = join(dir, entry);
		try {
			if (!lstatSync(fullPath).isSymbolicLink()) continue;
		} catch {
			continue;
		}

		// Extract plugin name from symlink filename: {plugin-name}--{agent-name}.md
		const baseName = entry.replace(/\.md$/, "");
		const separatorIdx = baseName.indexOf("--");
		if (separatorIdx === -1) continue;

		const pluginPrefix = baseName.slice(0, separatorIdx);
		if (!currentPluginNames.has(pluginPrefix)) {
			try {
				unlinkSync(fullPath);
			} catch {
				// Ignore cleanup failures
			}
		}
	}
}

/**
 * Create symlinks from the project's .pi/agents/cc-plugins/ to cached agent files.
 * Each symlink is named {plugin-name}--{agent-name}.md.
 */
export function linkAgents(
	projectRoot: string,
	cachedAgents: Array<{ pluginName: string; agentName: string; cachedPath: string }>,
): void {
	const dir = getAgentsLinkDir(projectRoot);
	mkdirSync(dir, { recursive: true });

	for (const { pluginName, agentName, cachedPath } of cachedAgents) {
		const safeName = agentName.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");
		const linkName = `${pluginName}--${safeName}.md`;
		const linkPath = join(dir, linkName);

		// Remove existing symlink if present
		try {
			if (lstatSync(linkPath).isSymbolicLink()) {
				unlinkSync(linkPath);
			}
		} catch {
			// File doesn't exist, that's fine
		}

		symlinkSync(cachedPath, linkPath);
	}
}

/**
 * Decrement refcount and clean up if it reaches 0.
 * Called on session_shutdown.
 */
export function unlinkAgents(projectRoot: string): void {
	decrementRefcount(projectRoot);
}

// ---------------------------------------------------------------------------
// pi-subagents detection
// ---------------------------------------------------------------------------

/**
 * Check if pi-subagents is installed by reading Pi's settings files
 * and looking for it in the `packages` array.
 */
export function isSubagentsInstalled(): boolean {
	const globalPath = join(homedir(), ".pi", "agent", "settings.json");
	const globalSettings = readJsonFile(globalPath);
	const packages = globalSettings.packages;

	if (!Array.isArray(packages)) return false;

	return packages.some((p) => {
		if (typeof p !== "string") return false;
		// Match npm:pi-subagents or any package name containing "pi-subagents" or "subagent"
		const lower = p.toLowerCase();
		return lower.includes("pi-subagents") || lower.includes("subagent");
	});
}
