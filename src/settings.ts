/**
 * Settings reading.
 *
 * Reads ccPlugins from Pi's global and project settings files,
 * merges them, and returns the plugin source array.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Read the ccPlugins array from Pi's merged settings.
 * Reads global (~/.pi/agent/settings.json) and project (.pi/settings.json) files,
 * merges them (project wins), and returns the ccPlugins array.
 */
export function readCcPlugins(cwd?: string, options?: { globalSettingsPath?: string }): string[] {
	const globalPath = options?.globalSettingsPath ?? join(homedir(), ".pi", "agent", "settings.json");
	const projectPath = cwd ? join(cwd, ".pi", "settings.json") : "";

	const globalSettings = readJsonFile(globalPath);
	const projectSettings = projectPath ? readJsonFile(projectPath) : {};

	// Merge: project overrides global for top-level keys
	const merged = { ...globalSettings, ...projectSettings };
	const ccPlugins = merged.ccPlugins;

	if (!Array.isArray(ccPlugins)) return [];
	return ccPlugins.filter((s) => typeof s === "string");
}

export function readJsonFile(filePath: string): Record<string, unknown> {
	if (!existsSync(filePath)) return {};
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
