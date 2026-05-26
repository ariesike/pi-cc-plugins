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
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ResolvedPlugin } from "./src/types.js";
import { parseSource } from "./src/source.js";
import { isMcpAdapterInstalled, readCcPlugins, readCcClaudeGlobal, readCcClaudeProject } from "./src/settings.js";
import { discoverAgentPaths, resolvePlugin } from "./src/plugin.js";
import { materializeSkillPaths, materializeStandaloneSkillPath, walkSkillDir } from "./src/skills.js";
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
import { hasManagedMcpState, syncProjectMcpConfig } from "./src/mcp.js";

export { parseSource } from "./src/source.js";
export { readCcPlugins, readCcClaudeGlobal, readCcClaudeProject, readPiPackages, isMcpAdapterInstalled, readJsonFile } from "./src/settings.js";
export { getCacheBaseDir, getCloneDir, ensureCloned } from "./src/cache.js";
export { resolvePlugin, readPluginName, discoverSkillPaths, discoverAgentPaths, discoverMcpConfigPaths } from "./src/plugin.js";
export { materializeSkillPaths, materializeStandaloneSkillPath, walkSkillDir, sanitizeSkillMarkdown, normalizeSkillName } from "./src/skills.js";
export type { ParsedSource, ResolvedPlugin, ParsedAgent, McpServerEntry, PluginMcpServer, ManagedMcpEntry, ManagedMcpSidecar, McpSyncResult } from "./src/types.js";
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
export {
	getProjectMcpConfigPath,
	getProjectMcpSidecarPath,
	hasManagedMcpState,
	normalizeMcpName,
	readPluginMcpServers,
	collectPluginMcpServers,
	syncProjectMcpConfig,
} from "./src/mcp.js";

/** Options accepted by the extension entry point. */
export interface ExtensionOptions {
	/** Override the global settings path (for testing). */
	globalSettingsPath?: string;
}

interface AgentSource {
	packageName: string;
	cacheSlug: string;
	agentPaths: string[];
}

export default function (pi: ExtensionAPI, options?: ExtensionOptions) {
	/** Cached resolved plugins for the current session */
	let resolvedPlugins: ResolvedPlugin[] = [];
	/** Materialized skill paths from .claude/skills (not from plugins) */
	let claudeSkillPaths: string[] = [];
	/** Agent sources from .claude/agents (not from plugins) */
	let claudeAgentSources: AgentSource[] = [];
	/** Track whether we incremented the refcount for this session */
	let hasRefcount = false;
	/** Track the cwd for cleanup on shutdown */
	let sessionCwd: string | null = null;

	/** Read ccPlugins using the configured or overridden global settings path. */
	const getPlugins = (cwd: string) => readCcPlugins(cwd, { globalSettingsPath: options?.globalSettingsPath });

	/** Read ccClaude* settings. */
	const getSettingsOpts = (cwd: string) => ({ globalSettingsPath: options?.globalSettingsPath });

	/**
	 * Discover and materialize skills from a .claude/skills directory.
	 * Returns an array of materialized cache paths.
	 */
	const loadClaudeSkills = (skillsDir: string, namespace: string, sourceId: string): string[] => {
		if (!existsSync(skillsDir)) return [];

		const discovered: string[] = [];
		walkSkillDir(skillsDir, discovered);

		return discovered.map((skillPath) =>
			materializeStandaloneSkillPath(namespace, sourceId, skillsDir, skillPath),
		);
	};

	const loadClaudeAgents = (claudeDir: string, packageName: string): AgentSource | null => {
		const agentPaths = discoverAgentPaths(claudeDir);
		if (agentPaths.length === 0) return null;
		return { packageName, cacheSlug: packageName, agentPaths };
	};

	pi.on("session_start", async (_event, ctx) => {
		sessionCwd = ctx.cwd;
		resolvedPlugins = [];
		claudeSkillPaths = [];
		claudeAgentSources = [];
		hasRefcount = false;

		const ccPlugins = getPlugins(ctx.cwd);
		const settingsOpts = getSettingsOpts(ctx.cwd);

		// --- Load .claude directories ---
		const ccClaudeGlobal = readCcClaudeGlobal(ctx.cwd, settingsOpts);
		const ccClaudeProject = readCcClaudeProject(ctx.cwd, settingsOpts);

		if (ccClaudeGlobal) {
			const globalClaudeDir = join(homedir(), ".claude");
			const globalClaudeSkillsDir = join(globalClaudeDir, "skills");
			const materialized = loadClaudeSkills(globalClaudeSkillsDir, "claude-global", "~/.claude/skills");
			claudeSkillPaths.push(...materialized);

			const agentSource = loadClaudeAgents(globalClaudeDir, "claude-global");
			if (agentSource) claudeAgentSources.push(agentSource);
		}

		if (ccClaudeProject) {
			const projectClaudeDir = join(ctx.cwd, ".claude");
			const projectClaudeSkillsDir = join(projectClaudeDir, "skills");
			const materialized = loadClaudeSkills(projectClaudeSkillsDir, "claude-project", ".claude/skills");
			claudeSkillPaths.push(...materialized);

			const agentSource = loadClaudeAgents(projectClaudeDir, "claude-project");
			if (agentSource) claudeAgentSources.push(agentSource);
		}

		// --- Load ccPlugins ---
		const errors: string[] = [];
		const warnings: string[] = [];

		for (const raw of ccPlugins) {
			try {
				const source = parseSource(raw);
				const plugin = resolvePlugin(source, ctx.cwd);
				plugin.skillPaths = materializeSkillPaths(plugin);
				resolvedPlugins.push(plugin);
			} catch (err: any) {
				errors.push(`  ${raw}: ${err?.message || err}`);
			}
		}

		// --- MCP handling (from ccPlugins) ---
		let mcpServerCount = 0;
		const totalMcpConfigPaths = resolvedPlugins.reduce(
			(sum, plugin) => sum + plugin.mcpConfigPaths.length,
			0,
		);

		if (totalMcpConfigPaths > 0 || hasManagedMcpState(ctx.cwd)) {
			if (!isMcpAdapterInstalled({ globalSettingsPath: options?.globalSettingsPath })) {
				if (totalMcpConfigPaths > 0) {
					ctx.ui.notify(
						`cc-plugins: found ${totalMcpConfigPaths} MCP config(s) in configured Claude plugins but pi-mcp-adapter is not installed. ` +
						`Install it with: pi install npm:pi-mcp-adapter`,
						"warning",
					);
				}
			} else {
				try {
					const result = syncProjectMcpConfig(ctx.cwd, resolvedPlugins);
					mcpServerCount = result.writtenCount;
					warnings.push(...result.warnings.map((warning) => `  mcp ${warning}`));
				} catch (err: any) {
					errors.push(`  mcp: ${err?.message || err}`);
				}
			}
		}

		// --- Agent handling (from ccPlugins and standalone .claude/agents) ---
		let agentCount = 0;
		const pluginAgentSources: AgentSource[] = resolvedPlugins.map((plugin) => ({
			packageName: plugin.name,
			cacheSlug: plugin.source.ref.replace(/[\/\\]/g, "--"),
			agentPaths: plugin.agentPaths,
		}));
		const agentSources = [...pluginAgentSources, ...claudeAgentSources];
		const totalAgentPaths = agentSources.reduce(
			(sum, source) => sum + source.agentPaths.length,
			0,
		);

		if (totalAgentPaths > 0) {
			if (!isSubagentsInstalled({ globalSettingsPath: options?.globalSettingsPath })) {
				ctx.ui.notify(
					`cc-plugins: found ${totalAgentPaths} agent(s) in configured Claude sources but pi-subagents is not installed. ` +
					`Install it with: pi install npm:pi-subagents`,
					"warning",
				);
			} else {
				// Increment refcount to protect symlinks from concurrent session cleanup
				incrementRefcount(ctx.cwd);
				hasRefcount = true;

				// Clean stale symlinks from sources no longer configured
				const currentPackageNames = new Set(agentSources.map((source) => source.packageName));
				cleanupStaleSymlinks(ctx.cwd, currentPackageNames);

				// Convert and cache agents, then create symlinks
				const cachedAgents: Array<{ pluginName: string; agentName: string; cachedPath: string }> = [];

				for (const source of agentSources) {
					for (const agentPath of source.agentPaths) {
						try {
							const parsed = parseCcAgent(agentPath);
							if (!parsed) continue;

							const converted = convertCcAgent(parsed, source.packageName);
							const cachedPath = writeCachedAgent(source.cacheSlug, parsed.name, converted);

							cachedAgents.push({
								pluginName: source.packageName,
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

		// --- Notification ---
		const pluginSkillCount = resolvedPlugins.reduce((sum, p) => sum + p.skillPaths.length, 0);
		const claudeSkillCount = claudeSkillPaths.length;
		const totalSkillCount = pluginSkillCount + claudeSkillCount;

		if (totalSkillCount > 0 || agentCount > 0 || mcpServerCount > 0 || resolvedPlugins.length > 0) {
			const parts: string[] = [];
			if (totalSkillCount > 0) parts.push(`${totalSkillCount} skill(s)`);
			if (agentCount > 0) parts.push(`${agentCount} agent(s)`);
			if (mcpServerCount > 0) parts.push(`${mcpServerCount} MCP server(s)`);
			if (resolvedPlugins.length > 0) parts.push(`${resolvedPlugins.length} plugin(s)`);
			ctx.ui.notify(`cc-plugins: loaded ${parts.join(" and ")}`, "info");
		}

		if (warnings.length > 0) {
			ctx.ui.notify(
				`cc-plugins: ${warnings.length} warning(s):\n${warnings.join("\n")}`,
				"warning",
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
		const pluginSkillPaths = resolvedPlugins.flatMap((p) => p.skillPaths);
		const allSkillPaths = [...pluginSkillPaths, ...claudeSkillPaths];
		if (allSkillPaths.length === 0) return undefined;
		return { skillPaths: allSkillPaths };
	});

	pi.on("session_shutdown", () => {
		if (hasRefcount && sessionCwd) {
			unlinkAgents(sessionCwd);
			hasRefcount = false;
		}
	});
}
