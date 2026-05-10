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
	/** The parsed source this plugin came from */
	source: ParsedSource;
}
