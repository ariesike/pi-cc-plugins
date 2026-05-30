import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * Extract repeatable --plugin-dir values from raw argv.
 * Pi extension flags are string-valued and keep only one value, so we also
 * inspect process.argv to match Claude Code's repeatable flag behavior.
 */
export function parsePluginDirArgv(argv: string[] = process.argv): string[] {
	const values: string[] = [];

	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--") break;

		if (arg === "--plugin-dir") {
			const next = argv[index + 1];
			if (next == null || next.startsWith("-")) continue;
			values.push(next);
			index++;
			continue;
		}

		if (arg.startsWith("--plugin-dir=")) {
			const value = arg.slice("--plugin-dir=".length);
			if (value) values.push(value);
		}
	}

	return values;
}

/** Convert Pi's single extension-flag value into zero or one plugin-dir args. */
export function parsePluginDirFlagValue(value: unknown): string[] {
	if (typeof value !== "string") return [];
	const trimmed = value.trim();
	return trimmed ? [trimmed] : [];
}

/** Resolve a plugin-dir CLI value the same way Claude users expect paths to work. */
export function resolvePluginDirArg(value: string, cwd: string): string {
	if (value === "~" || value.startsWith("~/")) {
		return value === "~" ? homedir() : join(homedir(), value.slice(2));
	}

	if (isAbsolute(value)) return resolve(value);
	return resolve(cwd, value);
}

/**
 * Return session-only local source strings for all --plugin-dir values.
 * Values are de-duplicated after path resolution while preserving order.
 */
export function readPluginDirSources(
	cwd: string,
	flagValue?: unknown,
	argv: string[] = process.argv,
): string[] {
	const rawValues = [
		...parsePluginDirArgv(argv),
		...parsePluginDirFlagValue(flagValue),
	];
	const seen = new Set<string>();
	const sources: string[] = [];

	for (const rawValue of rawValues) {
		const resolvedPath = resolvePluginDirArg(rawValue, cwd);
		if (seen.has(resolvedPath)) continue;
		seen.add(resolvedPath);
		sources.push(`local:${resolvedPath}`);
	}

	return sources;
}
