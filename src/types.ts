/**
 * Shared types and constants for pi-cc-plugins.
 */

/** Supported source types. */
export const SOURCE_TYPES = {
	github: "github",
	git: "git",
	local: "local",
} as const;

/** Derived type from the SOURCE_TYPES keys. */
export type SourceType = keyof typeof SOURCE_TYPES;

export interface ParsedSource {
	/** Source type */
	type: SourceType;
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
	/** Absolute paths to agent .md files found in this plugin */
	agentPaths: string[];
	/** Absolute paths to MCP config files found in this plugin */
	mcpConfigPaths: string[];
	/** The parsed source this plugin came from */
	source: ParsedSource;
}

/** Parsed frontmatter from a Claude Code agent .md file. */
export interface ParsedAgent {
	/** Agent name from frontmatter */
	name: string;
	/** Agent description from frontmatter */
	description: string;
	/** Source model value, parsed for compatibility but not emitted in converted Pi agents */
	model?: string;
	/** Source tool allowlist, parsed for compatibility but not emitted in converted Pi agents */
	tools?: string;
	/** Comma-separated skill names to preload */
	skills?: string;
	/** System prompt body (everything after frontmatter) */
	systemPrompt: string;
	/** Absolute path to the original agent file */
	filePath: string;
}

export type McpServerEntry = Record<string, unknown>;

export interface PluginMcpServer {
	pluginName: string;
	originalName: string;
	generatedName: string;
	definition: McpServerEntry;
	configPath: string;
}

export interface ManagedMcpEntry {
	name: string;
	pluginName: string;
	originalName: string;
	configPath: string;
}

export interface ManagedMcpSidecar {
	version: 1;
	entries: ManagedMcpEntry[];
}

export interface McpSyncResult {
	serverCount: number;
	writtenCount: number;
	changed: boolean;
	configPath: string;
	sidecarPath: string;
	warnings: string[];
}

/** Runtime environment context for a materialized Claude Code skill. */
export interface SkillEnvContext {
	/** Plugin/package name the skill came from. */
	pluginName: string;
	/** Original Claude plugin root directory. */
	pluginRoot: string;
	/** Original skill directory under the plugin root. */
	skillDir: string;
	/** Pi-compatible cached skill directory returned via resources_discover. */
	materializedDir: string;
	/** Pi-compatible cached SKILL.md path. */
	skillFilePath: string;
}

export interface MaterializedSkillPaths {
	skillPaths: string[];
	envContexts: SkillEnvContext[];
}
