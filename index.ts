/**
 * pi-cc-plugins — Use Claude Code plugins (skills) directly in Pi
 *
 * Reads plugin sources from Pi's settings.json, clones missing repos into
 * an XDG cache directory, and exposes their skills/ directories via the
 * resources_discover event so Pi loads them natively.
 *
 * Settings (in ~/.pi/agent/settings.json or .pi/settings.json):
 *
 *   {
 *     "ccPlugins": [
 *       "github:pleaseai/claude-code-plugins",
 *       "github:pleaseai/claude-code-plugins#subpath=plugins/vue",
 *       "git:github.com/user/custom-plugin",
 *       "local:~/my-plugins/dev-plugin"
 *     ]
 *   }
 *
 * Install:
 *   pi install git:git@github.com:asermax/pi-cc-plugins
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedSource {
	/** Source type */
	type: "github" | "git" | "local";
	/** The repo/path portion (e.g. "owner/repo" for github, full URL for git, local path for local) */
	ref: string;
	/** Optional subpath within the cloned repo to use as plugin root */
	subpath?: string;
	/** Original raw source string */
	raw: string;
}

export interface ResolvedPlugin {
	/** Absolute path to the plugin root directory */
	rootDir: string;
	/** Plugin name from .claude-plugin/plugin.json, or directory-derived fallback */
	name: string;
	/** Absolute paths to skills/ directories found in this plugin */
	skillPaths: string[];
	/** The parsed source this plugin came from */
	source: ParsedSource;
}

// ---------------------------------------------------------------------------
// Source parsing
// ---------------------------------------------------------------------------

/**
 * Parse a ccPlugins source string into a structured representation.
 *
 * Supported formats:
 *   github:owner/repo
 *   github:owner/repo#subpath=some/dir
 *   git:github.com/user/repo
 *   git:github.com/user/repo#subpath=some/dir
 *   local:/absolute/path
 *   local:~/relative/path
 *   local:./relative/path
 */
export function parseSource(raw: string): ParsedSource {
	const [main, fragment] = splitFragment(raw);

	if (main.startsWith("github:")) {
		const ref = main.slice("github:".length);
		if (!ref.includes("/")) {
			throw new Error(`Invalid github source: "${raw}" — expected "github:owner/repo"`);
		}
		return { type: "github", ref, subpath: fragment, raw };
	}

	if (main.startsWith("git:")) {
		const ref = main.slice("git:".length);
		if (!ref) {
			throw new Error(`Invalid git source: "${raw}" — expected "git:<url>"`);
		}
		return { type: "git", ref, subpath: fragment, raw };
	}

	if (main.startsWith("local:")) {
		const ref = main.slice("local:".length);
		if (!ref) {
			throw new Error(`Invalid local source: "${raw}" — expected "local:<path>"`);
		}
		return { type: "local", ref, subpath: fragment, raw };
	}

	throw new Error(
		`Unknown source format: "${raw}" — expected "github:...", "git:...", or "local:..."`,
	);
}

/**
 * Split a source string into the main part and the #subpath= fragment.
 * Returns [main, subpath | undefined].
 */
function splitFragment(raw: string): [string, string | undefined] {
	const hashIdx = raw.indexOf("#subpath=");
	if (hashIdx === -1) return [raw, undefined];
	return [raw.slice(0, hashIdx), raw.slice(hashIdx + "#subpath=".length)];
}

// ---------------------------------------------------------------------------
// Cache directory
// ---------------------------------------------------------------------------

const XDG_CACHE = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
const CACHE_DIR = join(XDG_CACHE, "pi-cc-plugins");

/** Return the XDG cache base directory. */
export function getCacheBaseDir(): string {
	return CACHE_DIR;
}

/**
 * Return the directory path where a given remote source will be cloned.
 * Uses the pattern <owner>--<repo> for github sources, and a slug for git URLs.
 */
export function getCloneDir(source: ParsedSource): string {
	if (source.type === "github") {
		// owner/repo → owner--repo
		const slug = source.ref.replace("/", "--");
		return join(CACHE_DIR, slug);
	}
	if (source.type === "git") {
		// Derive a slug from the URL
		// e.g. github.com/user/repo → github.com--user--repo
		const cleaned = source.ref
			.replace(/^https?:\/\//, "")
			.replace(/\.git$/, "")
			.replace(/\/$/, "");
		const slug = cleaned.replace(/\//g, "--");
		return join(CACHE_DIR, slug);
	}
	// local sources aren't cloned
	return "";
}

// ---------------------------------------------------------------------------
// Settings reading
// ---------------------------------------------------------------------------

/**
 * Read the ccPlugins array from Pi's merged settings.
 * Reads global (~/.pi/agent/settings.json) and project (.pi/settings.json) files,
 * merges them (project wins), and returns the ccPlugins array.
 */
export function readCcPlugins(cwd?: string): string[] {
	const globalPath = join(homedir(), ".pi", "agent", "settings.json");
	const projectPath = cwd ? join(cwd, ".pi", "settings.json") : "";

	const globalSettings = readJsonFile(globalPath);
	const projectSettings = projectPath ? readJsonFile(projectPath) : {};

	// Merge: project overrides global for top-level keys
	const merged = { ...globalSettings, ...projectSettings };
	const ccPlugins = merged.ccPlugins;

	if (!Array.isArray(ccPlugins)) return [];
	return ccPlugins.filter((s) => typeof s === "string");
}

function readJsonFile(filePath: string): Record<string, unknown> {
	try {
		const content = readFileSync(filePath, "utf-8");
		// Strip comments (simple // line comments only)
		const cleaned = content
			.split("\n")
			.filter((line) => !line.trim().startsWith("//"))
			.join("\n");
		return JSON.parse(cleaned);
	} catch {
		return {};
	}
}

// ---------------------------------------------------------------------------
// Plugin installation (git clone)
// ---------------------------------------------------------------------------

/**
 * Clone a remote source into the cache directory if not already present.
 * Returns the clone directory path.
 * Throws on clone failure.
 */
export function ensureCloned(source: ParsedSource): string {
	const cloneDir = getCloneDir(source);
	if (!cloneDir) throw new Error(`Cannot clone local source: ${source.raw}`);

	// Already cloned — skip
	if (existsSync(join(cloneDir, ".git"))) {
		return cloneDir;
	}

	// Ensure cache base dir exists
	mkdirSync(CACHE_DIR, { recursive: true });

	const gitUrl = resolveGitUrl(source);

	try {
		execSync(`git clone --depth 1 ${quote(gitUrl)} ${quote(cloneDir)}`, {
			stdio: "pipe",
			timeout: 60_000,
		});
	} catch (err: any) {
		// Clean up partial clone
		try {
			if (existsSync(cloneDir)) {
				execSync(`rm -rf ${quote(cloneDir)}`, { stdio: "pipe" });
			}
		} catch {
			// Ignore cleanup failure
		}
		throw new Error(`Failed to clone ${source.raw}: ${err?.stderr?.toString()?.trim() || err?.message || "unknown error"}`);
	}

	return cloneDir;
}

function resolveGitUrl(source: ParsedSource): string {
	if (source.type === "github") {
		return `https://github.com/${source.ref}.git`;
	}
	// git: source — ref is already a URL-ish string
	if (source.ref.startsWith("https://") || source.ref.startsWith("git@") || source.ref.startsWith("ssh://")) {
		return source.ref;
	}
	// Assume it's a domain-less path like github.com/user/repo
	return `https://${source.ref}.git`;
}

function quote(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}

// ---------------------------------------------------------------------------
// Plugin resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a single ccPlugins source string into a ResolvedPlugin.
 * Handles cloning (for remote sources) and skill path discovery.
 */
export function resolvePlugin(source: ParsedSource, cwd?: string): ResolvedPlugin {
	let rootDir: string;

	if (source.type === "local") {
		// Resolve local path
		let localPath = source.ref;
		if (localPath.startsWith("~/")) {
			localPath = join(homedir(), localPath.slice(2));
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

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	/** Cached resolved plugins for the current session */
	let resolvedPlugins: ResolvedPlugin[] = [];

	pi.on("session_start", async (_event, ctx) => {
		resolvedPlugins = [];

		const ccPlugins = readCcPlugins(ctx.cwd);
		if (ccPlugins.length === 0) return;

		const errors: string[] = [];

		for (const raw of ccPlugins) {
			try {
				const source = parseSource(raw);
				const plugin = resolvePlugin(source, ctx.cwd);
				resolvedPlugins.push(plugin);
			} catch (err: any) {
				errors.push(`  ${raw}: ${err?.message || err}`);
			}
		}

		if (resolvedPlugins.length > 0) {
			const skillCount = resolvedPlugins.reduce(
				(sum, p) => sum + p.skillPaths.length,
				0,
			);
			ctx.ui.notify(
				`cc-plugins: loaded ${skillCount} skill(s) from ${resolvedPlugins.length} plugin(s)`,
				"info",
			);
		}

		if (errors.length > 0) {
			ctx.ui.notify(
				`cc-plugins: ${errors.length} error(s):\n${errors.join("\n")}`,
				"warning",
			);
		}
	});

	pi.on("resources_discover", async (_event, _ctx) => {
		const skillPaths = resolvedPlugins.flatMap((p) => p.skillPaths);
		if (skillPaths.length === 0) return undefined;
		return { skillPaths };
	});
}
