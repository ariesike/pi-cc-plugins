/**
 * Cache management and git cloning.
 *
 * Handles resolving cache directories and cloning remote plugin sources.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SOURCE_TYPES, type ParsedSource, type SourceType } from "./types.js";

const XDG_CACHE = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
const CACHE_DIR = join(XDG_CACHE, "pi-cc-plugins");

/** Return the XDG cache base directory. */
export function getCacheBaseDir(): string {
	return CACHE_DIR;
}

/** Map a source type to a slug for use as the cache directory name. */
const slugify: Record<SourceType, (ref: string) => string> = {
	[SOURCE_TYPES.github]: (ref) => ref.replace("/", "--"),
	[SOURCE_TYPES.git]: (ref) =>
		ref
			.replace(/^https?:\/\//, "")
			.replace(/\.git$/, "")
			.replace(/\/$/, "")
			.replace(/\//g, "--"),
	[SOURCE_TYPES.local]: () => "",
};

/**
 * Return the directory path where a given remote source will be cloned.
 * Uses the pattern <owner>--<repo> for github sources, and a slug for git URLs.
 */
export function getCloneDir(source: ParsedSource): string {
	const slug = slugify[source.type](source.ref);
	return slug ? join(CACHE_DIR, slug) : "";
}

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
	if (source.type === SOURCE_TYPES.github) {
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
