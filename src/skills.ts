/**
 * Skill compatibility helpers.
 *
 * Claude Code accepts loose frontmatter in SKILL.md files. Pi parses the same
 * frontmatter as strict YAML and also validates skill names. To keep plugin
 * sources untouched, materialize skill directories into the pi-cc-plugins cache
 * and rewrite only the copied SKILL.md frontmatter into Pi-compatible YAML.
 */
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { getCacheBaseDir } from "./cache.js";
import type { ResolvedPlugin } from "./types.js";

/** Copy discovered skill directories to cache and sanitize their SKILL.md files. */
export function materializeSkillPaths(plugin: ResolvedPlugin): string[] {
	return plugin.skillPaths.map((skillPath) => {
		const relativeSkillPath = relative(plugin.rootDir, skillPath);
		const cacheSkillPath = join(
			getCacheBaseDir(),
			"skills",
			normalizeSkillName(plugin.name, "plugin"),
			hash(`${plugin.source.raw}\n${plugin.rootDir}`),
			slugPath(relativeSkillPath || basename(skillPath)),
		);

		return copyAndSanitizeSkillDir(skillPath, cacheSkillPath);
	});
}

/**
 * Materialize a standalone skill directory (not from a plugin).
 * Uses a namespace and source ID for cache isolation.
 */
export function materializeStandaloneSkillPath(
	namespace: string,
	sourceId: string,
	rootDir: string,
	skillPath: string,
): string {
	const relativeSkillPath = relative(rootDir, skillPath);
	const cacheSkillPath = join(
		getCacheBaseDir(),
		"skills",
		normalizeSkillName(namespace, "standalone"),
		hash(sourceId),
		slugPath(relativeSkillPath || basename(skillPath)),
	);

	return copyAndSanitizeSkillDir(skillPath, cacheSkillPath);
}

/**
 * Copy a skill directory to a cache path and sanitize its SKILL.md frontmatter.
 */
function copyAndSanitizeSkillDir(skillPath: string, cacheSkillPath: string): string {
	rmSync(cacheSkillPath, { recursive: true, force: true });
	mkdirSync(cacheSkillPath, { recursive: true });
	cpSync(skillPath, cacheSkillPath, { recursive: true, force: true });

	const skillFilePath = join(cacheSkillPath, "SKILL.md");
	if (existsSync(skillFilePath)) {
		writeFileSync(
			skillFilePath,
			sanitizeSkillMarkdown(readFileSync(skillFilePath, "utf-8"), basename(skillPath)),
		);
	}

	return cacheSkillPath;
}

/** Rewrite a SKILL.md document so Pi can parse its frontmatter as strict YAML. */
export function sanitizeSkillMarkdown(content: string, fallbackName: string): string {
	const frontmatter = splitFrontmatter(content);
	if (frontmatter == null) {
		return content;
	}

	return [
		"---",
		...sanitizeFrontmatterLines(frontmatter.frontmatter, fallbackName),
		"---",
		frontmatter.body.replace(/^\r?\n/, ""),
	].join("\n");
}

/** Normalize a skill name to Pi's lowercase a-z, 0-9, hyphen format. */
export function normalizeSkillName(name: string, fallbackName = "skill"): string {
	const normalized = name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");

	if (normalized) return normalized;
	return normalizeSkillName(fallbackName, "skill");
}

/**
 * Recursively walk a directory to find skill directories (containing SKILL.md).
 * Returns the parent directories of SKILL.md files.
 */
export function walkSkillDir(dir: string, results: string[]): void {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}

	if (entries.some((e) => e.isFile() && e.name === "SKILL.md")) {
		results.push(dir);
		return;
	}

	for (const entry of entries) {
		if (entry.isDirectory() && !entry.name.startsWith(".")) {
			walkSkillDir(join(dir, entry.name), results);
		}
	}
}

function splitFrontmatter(content: string): { frontmatter: string; body: string } | null {
	if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) return null;

	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
	if (match == null) return null;

	return {
		frontmatter: match[1],
		body: match[2],
	};
}

function sanitizeFrontmatterLines(frontmatter: string, fallbackName: string): string[] {
	const lines = frontmatter.split(/\r?\n/);
	const sanitized: string[] = [];
	let hasName = false;

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		const keyValue = /^([A-Za-z0-9_-]+):(.*)$/.exec(line);

		if (keyValue == null) {
			sanitized.push(line);
			continue;
		}

		const key = keyValue[1];
		const value = keyValue[2].trim();

		if (key === "name") {
			hasName = true;
			sanitized.push(`name: ${quoteYamlString(normalizeSkillName(stripOuterQuotes(value), fallbackName))}`);
			continue;
		}

		if (isBlockScalar(value)) {
			sanitized.push(line);
			continue;
		}

		if (value === "") {
			sanitized.push(line);
			continue;
		}

		sanitized.push(`${key}: ${formatYamlScalar(value)}`);
	}

	if (!hasName) {
		sanitized.unshift(`name: ${quoteYamlString(normalizeSkillName(fallbackName))}`);
	}

	return sanitized;
}

function formatYamlScalar(value: string): string {
	const unquoted = stripOuterQuotes(value);
	if (/^(true|false|null)$/i.test(unquoted) || /^-?\d+(\.\d+)?$/.test(unquoted)) {
		return unquoted;
	}

	return quoteYamlString(unquoted);
}

function stripOuterQuotes(value: string): string {
	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		return value.slice(1, -1);
	}

	return value;
}

function quoteYamlString(value: string): string {
	return JSON.stringify(value);
}

function isBlockScalar(value: string): boolean {
	return value === "|" || value === ">" || value.startsWith("|+") || value.startsWith("|-") || value.startsWith(">+") || value.startsWith(">-");
}

function slugPath(value: string): string {
	return value
		.split(/[\\/]+/g)
		.map((part) => normalizeSkillName(part, "part"))
		.join("--");
}

function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 12);
}
