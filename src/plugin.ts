/**
 * Plugin resolution and skill discovery.
 *
 * Resolves plugin sources into concrete directories, reads manifests,
 * and discovers SKILL.md files within plugin structures.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { SOURCE_TYPES, type ParsedSource, ResolvedPlugin } from "./types.js";
import { ensureCloned } from "./cache.js";

/**
 * Resolve a single ccPlugins source string into a ResolvedPlugin.
 * Handles cloning (for remote sources) and skill path discovery.
 */
export function resolvePlugin(source: ParsedSource, cwd?: string): ResolvedPlugin {
	let rootDir: string;

	if (source.type === SOURCE_TYPES.local) {
		// Resolve local path
		let localPath = source.ref;
		if (localPath === "~" || localPath.startsWith("~/")) {
			localPath = localPath === "~" ? homedir() : join(homedir(), localPath.slice(2));
		} else if (localPath.startsWith("./")) {
			localPath = resolve(cwd || process.cwd(), localPath);
		}
		rootDir = resolve(localPath);

		if (!existsSync(rootDir)) {
			throw new Error(`Local plugin path does not exist: ${rootDir} (from "${source.raw}")`);
		}
	} else {
		// Remote source — clone if needed
		const cloneDir = ensureCloned(source);
		rootDir = cloneDir;
	}

	// Apply subpath if specified
	if (source.subpath) {
		rootDir = join(rootDir, source.subpath);
		if (!existsSync(rootDir)) {
			throw new Error(
				`Plugin subpath does not exist: ${rootDir} (from "${source.raw}")`,
			);
		}
	}

	// Read plugin name from manifest
	const name = readPluginName(rootDir);

	// Discover skills/ directories
	const skillPaths = discoverSkillPaths(rootDir);

	return { rootDir, name, skillPaths, source };
}

/**
 * Read the plugin name from .claude-plugin/plugin.json.
 * Falls back to the directory name if no manifest exists.
 */
export function readPluginName(pluginDir: string): string {
	const manifestPath = join(pluginDir, ".claude-plugin", "plugin.json");
	try {
		const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
		if (manifest.name && typeof manifest.name === "string") {
			return manifest.name;
		}
	} catch {
		// No manifest or invalid JSON — fall through
	}
	// Fallback to directory name
	return pluginDir.replace(/\/+$/, "").split("/").pop() || "unknown";
}

/**
 * Discover skill directories within a plugin root.
 * Looks for a top-level `skills/` directory and returns the absolute paths
 * to any subdirectories containing a SKILL.md file.
 * Also respects the `skills` field in plugin.json if it specifies a custom path.
 */
export function discoverSkillPaths(pluginDir: string): string[] {
	const paths: string[] = [];

	// Check if plugin.json specifies a custom skills path
	let skillsDir = join(pluginDir, "skills");
	const manifestPath = join(pluginDir, ".claude-plugin", "plugin.json");
	try {
		const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
		if (manifest.skills && typeof manifest.skills === "string") {
			// Custom skills path (relative to plugin root)
			const customPath = manifest.skills.replace(/^\.\//, "");
			skillsDir = join(pluginDir, customPath);
		}
	} catch {
		// Use default skills/ path
	}

	if (!existsSync(skillsDir) || !statSync(skillsDir).isDirectory()) {
		return paths;
	}

	// Walk the skills directory and find directories containing SKILL.md
	walkSkillDir(skillsDir, paths);

	return paths;
}

/**
 * Recursively walk a directory to find skill directories (containing SKILL.md).
 * Claude Code plugins can have nested skill directories like:
 *   skills/code-reviewer/SKILL.md
 *   skills/pdf-processor/SKILL.md
 * We return the parent directories of SKILL.md files.
 */
function walkSkillDir(dir: string, results: string[]): void {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}

	// If this directory contains SKILL.md, it's a skill directory itself
	if (entries.some((e) => e.isFile() && e.name === "SKILL.md")) {
		results.push(dir);
		return;
	}

	// Otherwise, recurse into subdirectories
	for (const entry of entries) {
		if (entry.isDirectory() && !entry.name.startsWith(".")) {
			walkSkillDir(join(dir, entry.name), results);
		}
	}
}
