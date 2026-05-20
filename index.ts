/**
 * pi-cc-plugins — Use Claude Code plugins (skills & agents) directly in Pi
 *
 * Reads plugin sources from Pi's settings.json, clones missing repos into
 * an XDG cache directory, and exposes their skills/ directories via the
 * resources_discover event so Pi loads them natively.
 *
 * When pi-subagents is installed, also discovers agents/ directories in
 * plugins and converts them to pi-subagents format via symlinks in
 * .pi/agents/cc-plugins/.
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
import type { ResolvedPlugin } from "./src/types.js";
import { parseSource } from "./src/source.js";
import { readCcPlugins } from "./src/settings.js";
import { resolvePlugin } from "./src/plugin.js";
import {
	parseCcAgent,
	convertCcAgent,
	writeCachedAgent,
	linkAgents,
	unlinkAgents,
	incrementRefcount,
	cleanupStaleSymlinks,
	isSubagentsInstalled,
} from "./src/agents.js";

export { parseSource } from "./src/source.js";
export { readCcPlugins, readJsonFile } from "./src/settings.js";
export { getCacheBaseDir, getCloneDir, ensureCloned } from "./src/cache.js";
export { resolvePlugin, readPluginName, discoverSkillPaths, discoverAgentPaths } from "./src/plugin.js";
export type { ParsedSource, ResolvedPlugin, ParsedAgent } from "./src/types.js";
export {
	parseFrontmatter,
	parseCcAgent,
	convertCcAgent,
	writeCachedAgent,
	linkAgents,
	unlinkAgents,
	incrementRefcount,
	cleanupStaleSymlinks,
	isSubagentsInstalled,
} from "./src/agents.js";

/** Options accepted by the extension entry point. */
export interface ExtensionOptions {
	/** Override the global settings path (for testing). */
	globalSettingsPath?: string;
}

export default function (pi: ExtensionAPI, options?: ExtensionOptions) {
	/** Cached resolved plugins for the current session */
	let resolvedPlugins: ResolvedPlugin[] = [];
	/** Track whether we incremented the refcount for this session */
	let hasRefcount = false;
	/** Track the cwd for cleanup on shutdown */
	let sessionCwd: string | null = null;

	/** Read ccPlugins using the configured or overridden global settings path. */
	const getPlugins = (cwd: string) => readCcPlugins(cwd, { globalSettingsPath: options?.globalSettingsPath });

	pi.on("session_start", async (_event, ctx) => {
		sessionCwd = ctx.cwd;
		resolvedPlugins = [];
		hasRefcount = false;

		const ccPlugins = getPlugins(ctx.cwd);
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

			// --- Agent handling ---
			const totalAgentPaths = resolvedPlugins.reduce(
				(sum, p) => sum + p.agentPaths.length,
				0,
			);

			let agentCount = 0;
			if (totalAgentPaths > 0) {
				if (!isSubagentsInstalled()) {
					ctx.ui.notify(
						`cc-plugins: found ${totalAgentPaths} agent(s) in plugins but pi-subagents is not installed. ` +
						`Install it with: pi install npm:pi-subagents`,
						"warning",
					);
				} else {
					// Increment refcount to protect symlinks from concurrent session cleanup
					incrementRefcount(ctx.cwd);
					hasRefcount = true;

					// Clean stale symlinks from plugins no longer configured
					const currentPluginNames = new Set(resolvedPlugins.map((p) => p.name));
					cleanupStaleSymlinks(ctx.cwd, currentPluginNames);

					// Convert and cache agents, then create symlinks
					const cachedAgents: Array<{ pluginName: string; agentName: string; cachedPath: string }> = [];

					for (const plugin of resolvedPlugins) {
						for (const agentPath of plugin.agentPaths) {
							try {
								const parsed = parseCcAgent(agentPath);
								if (!parsed) continue;

								const slug = plugin.source.ref.replace(/[\/\\]/g, "--");
								const converted = convertCcAgent(parsed, plugin.name);
								const cachedPath = writeCachedAgent(slug, parsed.name, converted);

								cachedAgents.push({
									pluginName: plugin.name,
									agentName: parsed.name,
									cachedPath,
								});
								agentCount++;
							} catch (err: any) {
								errors.push(`  agent ${agentPath}: ${err?.message || err}`);
							}
						}
					}

					if (cachedAgents.length > 0) {
						linkAgents(ctx.cwd, cachedAgents);
					}
				}
			}

			// Build notification message
			const parts: string[] = [];
			if (skillCount > 0) parts.push(`${skillCount} skill(s)`);
			if (agentCount > 0) parts.push(`${agentCount} agent(s)`);
			const loadedMsg = parts.length > 0
				? `loaded ${parts.join(" and ")} from ${resolvedPlugins.length} plugin(s)`
				: `loaded ${resolvedPlugins.length} plugin(s)`;
			ctx.ui.notify(`cc-plugins: ${loadedMsg}`, "info");
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

	pi.on("session_shutdown", () => {
		if (hasRefcount && sessionCwd) {
			unlinkAgents(sessionCwd);
			hasRefcount = false;
		}
	});
}
