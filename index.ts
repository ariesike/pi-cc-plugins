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
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ResolvedPlugin, SkillEnvContext } from "./src/types.js";
import { parseSource } from "./src/source.js";
import { readPluginDirSources } from "./src/plugin-dir.js";
import {
	isMcpAdapterInstalled,
	readCcPlugins,
	readCcClaudeGlobal,
	readCcClaudeProject,
} from "./src/settings.js";
import { discoverAgentPaths, resolvePlugin } from "./src/plugin.js";
import {
	materializePluginSkillPaths,
	materializeStandaloneSkillPath,
	walkSkillDir,
} from "./src/skills.js";
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
export {
	parsePluginDirArgv,
	parsePluginDirFlagValue,
	resolvePluginDirArg,
	readPluginDirSources,
} from "./src/plugin-dir.js";
export {
	readCcPlugins,
	readCcClaudeGlobal,
	readCcClaudeProject,
	readPiPackages,
	isMcpAdapterInstalled,
	readJsonFile,
} from "./src/settings.js";
export {
	getCacheBaseDir,
	getCloneDir,
	ensureCloned,
	updateClone,
} from "./src/cache.js";
export {
	resolvePlugin,
	readPluginName,
	discoverSkillPaths,
	discoverAgentPaths,
	discoverMcpConfigPaths,
} from "./src/plugin.js";
export {
	materializeSkillPaths,
	materializePluginSkillPaths,
	materializeStandaloneSkillPath,
	walkSkillDir,
	sanitizeSkillMarkdown,
	normalizeSkillName,
} from "./src/skills.js";
export type {
	ParsedSource,
	ResolvedPlugin,
	ParsedAgent,
	McpServerEntry,
	PluginMcpServer,
	ManagedMcpEntry,
	ManagedMcpSidecar,
	McpSyncResult,
	SkillEnvContext,
	MaterializedSkillPaths,
} from "./src/types.js";
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

function stripYamlScalar(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) return trimmed;

	if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
		try {
			return JSON.parse(trimmed);
		} catch {
			return trimmed.slice(1, -1);
		}
	}

	if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
		return trimmed.slice(1, -1).replace(/''/g, "'");
	}

	return trimmed;
}

function readSkillName(materializedDir: string): string | null {
	try {
		const content = readFileSync(join(materializedDir, "SKILL.md"), "utf-8");
		const match = /^name:\s*(.+)$/m.exec(content);
		return match ? stripYamlScalar(match[1]) : null;
	} catch {
		return null;
	}
}

function normalizeToolPath(rawPath: string, cwd: string): string {
	let value = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
	if (value === "~" || value.startsWith("~/")) {
		value = value === "~" ? homedir() : join(homedir(), value.slice(2));
	}
	return resolve(cwd, value);
}

function isSameOrInside(pathValue: string, rootValue: string): boolean {
	const target = resolve(pathValue);
	const root = resolve(rootValue);
	const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
	return target === root || target.startsWith(prefix);
}

function findSkillContextByPath(
	rawPath: string | undefined,
	cwd: string,
	contexts: SkillEnvContext[],
): SkillEnvContext | null {
	if (!rawPath) return null;
	const normalizedPath = normalizeToolPath(rawPath, cwd);

	for (const context of contexts) {
		if (
			normalizedPath === resolve(context.skillFilePath) ||
			isSameOrInside(normalizedPath, context.materializedDir) ||
			isSameOrInside(normalizedPath, context.skillDir)
		) {
			return context;
		}
	}

	return null;
}

function findSkillCommandContext(
	text: string,
	contextsByName: Map<string, SkillEnvContext>,
): SkillEnvContext | null {
	const match = /^\/skill:([^\s]+)/.exec(text.trim());
	if (!match) return null;
	return contextsByName.get(match[1]) ?? null;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function buildClaudeEnvExports(context: SkillEnvContext): string {
	return [
		`export CLAUDE_PLUGIN_ROOT=${shellQuote(context.pluginRoot)}`,
		`export CLAUDE_SKILL_DIR=${shellQuote(context.skillDir)}`,
	].join("\n");
}

function expandClaudeEnvPlaceholders(
	value: string,
	context: SkillEnvContext,
): string {
	return value
		.replace(
			/\$\{CLAUDE_PLUGIN_ROOT\}|\$CLAUDE_PLUGIN_ROOT/g,
			context.pluginRoot,
		)
		.replace(/\$\{CLAUDE_SKILL_DIR\}|\$CLAUDE_SKILL_DIR/g, context.skillDir);
}

const PATH_LIKE_TOOL_KEYS = new Set([
	"path",
	"paths",
	"cwd",
	"dir",
	"directory",
	"file",
	"files",
]);

function isPathLikeToolKey(key: string): boolean {
	return PATH_LIKE_TOOL_KEYS.has(key);
}

function expandToolInputPlaceholders(
	value: unknown,
	context: SkillEnvContext,
): void {
	if (!value || typeof value !== "object") return;

	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		if (typeof item === "string") {
			if (isPathLikeToolKey(key)) {
				(value as Record<string, unknown>)[key] = expandClaudeEnvPlaceholders(
					item,
					context,
				);
			}
			continue;
		}

		if (Array.isArray(item)) {
			const expandStrings = isPathLikeToolKey(key);
			for (let index = 0; index < item.length; index++) {
				const child = item[index];
				if (typeof child === "string") {
					if (expandStrings)
						item[index] = expandClaudeEnvPlaceholders(child, context);
				} else {
					expandToolInputPlaceholders(child, context);
				}
			}
			continue;
		}

		expandToolInputPlaceholders(item, context);
	}
}

function getToolInputPath(input: unknown): string | undefined {
	if (!input || typeof input !== "object" || Array.isArray(input))
		return undefined;
	const pathValue = (input as Record<string, unknown>).path;
	return typeof pathValue === "string" ? pathValue : undefined;
}

export default function (pi: ExtensionAPI, options?: ExtensionOptions) {
	// Register CLI flags
	pi.registerFlag("cc-plugins-update", {
		type: "boolean",
		description:
			"Update cached plugin repos before loading (git fetch + hard reset)",
	});
	pi.registerFlag("plugin-dir", {
		type: "string",
		description:
			"Load a Claude Code plugin directory for this Pi session only (repeatable via --plugin-dir A --plugin-dir B)",
	});

	/** Cached resolved plugins for the current session */
	let resolvedPlugins: ResolvedPlugin[] = [];
	/** Materialized skill paths from .claude/skills (not from plugins) */
	let claudeSkillPaths: string[] = [];
	/** Agent sources from .claude/agents (not from plugins) */
	let claudeAgentSources: AgentSource[] = [];
	/** Claude Code skill environment contexts keyed by materialized skills. */
	const skillEnvContexts: SkillEnvContext[] = [];
	let skillEnvContextsByName = new Map<string, SkillEnvContext>();
	let activeSkillContext: SkillEnvContext | null = null;
	/** Track whether we incremented the refcount for this session */
	let hasRefcount = false;
	/** Track the cwd for cleanup on shutdown */
	let sessionCwd: string | null = null;

	const originalClaudePluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
	const originalClaudeSkillDir = process.env.CLAUDE_SKILL_DIR;

	const restoreClaudeEnv = () => {
		if (originalClaudePluginRoot == null) delete process.env.CLAUDE_PLUGIN_ROOT;
		else process.env.CLAUDE_PLUGIN_ROOT = originalClaudePluginRoot;

		if (originalClaudeSkillDir == null) delete process.env.CLAUDE_SKILL_DIR;
		else process.env.CLAUDE_SKILL_DIR = originalClaudeSkillDir;
	};

	const setActiveSkillContext = (context: SkillEnvContext | null) => {
		activeSkillContext = context;
		if (!context) {
			restoreClaudeEnv();
			return;
		}

		process.env.CLAUDE_PLUGIN_ROOT = context.pluginRoot;
		process.env.CLAUDE_SKILL_DIR = context.skillDir;
	};

	const rebuildSkillEnvIndex = () => {
		skillEnvContextsByName = new Map<string, SkillEnvContext>();
		const contextsByDir = new Map(
			skillEnvContexts.map((context) => [
				resolve(context.materializedDir),
				context,
			]),
		);
		const orderedSkillDirs = [
			...resolvedPlugins.flatMap((plugin) => plugin.skillPaths),
			...claudeSkillPaths,
		];

		for (const skillDir of orderedSkillDirs) {
			const context = contextsByDir.get(resolve(skillDir));
			if (!context) continue;
			const name = readSkillName(context.materializedDir);
			if (name && !skillEnvContextsByName.has(name)) {
				skillEnvContextsByName.set(name, context);
			}
		}
	};

	/** Read ccPlugins using the configured or overridden global settings path. */
	const getPlugins = (cwd: string) =>
		readCcPlugins(cwd, { globalSettingsPath: options?.globalSettingsPath });

	/** Read ccClaude* settings. */
	const getSettingsOpts = () => ({
		globalSettingsPath: options?.globalSettingsPath,
	});

	/**
	 * Discover and materialize skills from a .claude/skills directory.
	 * Returns an array of materialized cache paths and records env contexts.
	 */
	const loadClaudeSkills = (
		skillsDir: string,
		namespace: string,
		sourceId: string,
		pluginRoot: string,
	): string[] => {
		if (!existsSync(skillsDir)) return [];

		const discovered: string[] = [];
		walkSkillDir(skillsDir, discovered);

		return discovered.map((skillPath) => {
			const materializedDir = materializeStandaloneSkillPath(
				namespace,
				sourceId,
				skillsDir,
				skillPath,
			);
			skillEnvContexts.push({
				pluginName: namespace,
				pluginRoot,
				skillDir: skillPath,
				materializedDir,
				skillFilePath: join(materializedDir, "SKILL.md"),
			});
			return materializedDir;
		});
	};

	const loadClaudeAgents = (
		claudeDir: string,
		packageName: string,
	): AgentSource | null => {
		const agentPaths = discoverAgentPaths(claudeDir);
		if (agentPaths.length === 0) return null;
		return { packageName, cacheSlug: packageName, agentPaths };
	};

	pi.on("session_start", async (_event, ctx) => {
		sessionCwd = ctx.cwd;
		resolvedPlugins = [];
		claudeSkillPaths = [];
		claudeAgentSources = [];
		skillEnvContexts.length = 0;
		activeSkillContext = null;
		restoreClaudeEnv();
		hasRefcount = false;

		const cliPluginDirs = readPluginDirSources(
			ctx.cwd,
			pi.getFlag("plugin-dir"),
		);
		const ccPlugins = [...getPlugins(ctx.cwd), ...cliPluginDirs];
		const settingsOpts = getSettingsOpts();

		// --- Load .claude directories ---
		const ccClaudeGlobal = readCcClaudeGlobal(ctx.cwd, settingsOpts);
		const ccClaudeProject = readCcClaudeProject(ctx.cwd, settingsOpts);

		if (ccClaudeGlobal) {
			const globalClaudeDir = join(homedir(), ".claude");
			const globalClaudeSkillsDir = join(globalClaudeDir, "skills");
			const materialized = loadClaudeSkills(
				globalClaudeSkillsDir,
				"claude-global",
				"~/.claude/skills",
				globalClaudeDir,
			);
			claudeSkillPaths.push(...materialized);

			const agentSource = loadClaudeAgents(globalClaudeDir, "claude-global");
			if (agentSource) claudeAgentSources.push(agentSource);
		}

		if (ccClaudeProject) {
			const projectClaudeDir = join(ctx.cwd, ".claude");
			const projectClaudeSkillsDir = join(projectClaudeDir, "skills");
			const materialized = loadClaudeSkills(
				projectClaudeSkillsDir,
				"claude-project",
				".claude/skills",
				projectClaudeDir,
			);
			claudeSkillPaths.push(...materialized);

			const agentSource = loadClaudeAgents(projectClaudeDir, "claude-project");
			if (agentSource) claudeAgentSources.push(agentSource);
		}

		// --- Load configured ccPlugins and session-only --plugin-dir sources ---
		const errors: string[] = [];
		const warnings: string[] = [];

		for (const raw of ccPlugins) {
			try {
				const source = parseSource(raw);
				const plugin = resolvePlugin(
					source,
					ctx.cwd,
					pi.getFlag("cc-plugins-update") as boolean | undefined,
				);
				const materialized = materializePluginSkillPaths(plugin);
				plugin.skillPaths = materialized.skillPaths;
				skillEnvContexts.push(...materialized.envContexts);
				resolvedPlugins.push(plugin);
			} catch (err: any) {
				errors.push(`  ${raw}: ${err?.message || err}`);
			}
		}
		rebuildSkillEnvIndex();

		// --- MCP handling (from resolved plugins) ---
		let mcpServerCount = 0;
		const totalMcpConfigPaths = resolvedPlugins.reduce(
			(sum, plugin) => sum + plugin.mcpConfigPaths.length,
			0,
		);

		if (totalMcpConfigPaths > 0 || hasManagedMcpState(ctx.cwd)) {
			if (
				!isMcpAdapterInstalled({
					globalSettingsPath: options?.globalSettingsPath,
				})
			) {
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
					warnings.push(
						...result.warnings.map((warning) => `  mcp ${warning}`),
					);
				} catch (err: any) {
					errors.push(`  mcp: ${err?.message || err}`);
				}
			}
		}

		// --- Agent handling (from ccPlugins and standalone .claude/agents) ---
		let agentCount = 0;
		const pluginAgentSources: AgentSource[] = resolvedPlugins.map((plugin) => ({
			packageName: plugin.name,
			cacheSlug: plugin.source.ref.replace(/[/\\]/g, "--"),
			agentPaths: plugin.agentPaths,
		}));
		const agentSources = [...pluginAgentSources, ...claudeAgentSources];
		const totalAgentPaths = agentSources.reduce(
			(sum, source) => sum + source.agentPaths.length,
			0,
		);

		if (totalAgentPaths > 0) {
			if (
				!isSubagentsInstalled({
					globalSettingsPath: options?.globalSettingsPath,
				})
			) {
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
				const currentPackageNames = new Set(
					agentSources.map((source) => source.packageName),
				);
				cleanupStaleSymlinks(ctx.cwd, currentPackageNames);

				// Convert and cache agents, then create symlinks
				const cachedAgents: Array<{
					pluginName: string;
					agentName: string;
					cachedPath: string;
				}> = [];

				for (const source of agentSources) {
					for (const agentPath of source.agentPaths) {
						try {
							const parsed = parseCcAgent(agentPath);
							if (!parsed) continue;

							const converted = convertCcAgent(parsed, source.packageName);
							const cachedPath = writeCachedAgent(
								source.cacheSlug,
								parsed.name,
								converted,
							);

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
		const pluginSkillCount = resolvedPlugins.reduce(
			(sum, p) => sum + p.skillPaths.length,
			0,
		);
		const claudeSkillCount = claudeSkillPaths.length;
		const totalSkillCount = pluginSkillCount + claudeSkillCount;

		if (
			totalSkillCount > 0 ||
			agentCount > 0 ||
			mcpServerCount > 0 ||
			resolvedPlugins.length > 0
		) {
			const parts: string[] = [];
			if (totalSkillCount > 0) parts.push(`${totalSkillCount} skill(s)`);
			if (agentCount > 0) parts.push(`${agentCount} agent(s)`);
			if (mcpServerCount > 0) parts.push(`${mcpServerCount} MCP server(s)`);
			if (resolvedPlugins.length > 0)
				parts.push(`${resolvedPlugins.length} plugin(s)`);
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

	pi.on("input", (event) => {
		const context = findSkillCommandContext(event.text, skillEnvContextsByName);
		if (context) setActiveSkillContext(context);
	});

	pi.on("before_agent_start", (event) => {
		if (skillEnvContexts.length === 0) return undefined;

		const active = activeSkillContext
			? ` Current Claude plugin environment: CLAUDE_PLUGIN_ROOT=${activeSkillContext.pluginRoot}, CLAUDE_SKILL_DIR=${activeSkillContext.skillDir}.`
			: "";

		return {
			systemPrompt: `${event.systemPrompt}\n\nClaude Code plugin compatibility is enabled by pi-cc-plugins. Loaded Claude Code plugin skills may reference \${CLAUDE_PLUGIN_ROOT} and \${CLAUDE_SKILL_DIR}. Bash tool calls are automatically exported with the active skill context, and non-Bash tool path arguments may use those placeholders.${active}`,
		};
	});

	pi.on("tool_call", (event, ctx) => {
		const pathContext = findSkillContextByPath(
			getToolInputPath(event.input),
			ctx.cwd,
			skillEnvContexts,
		);
		if (pathContext) setActiveSkillContext(pathContext);

		const active = activeSkillContext;
		if (!active) return undefined;

		if (event.toolName === "bash") {
			const input = event.input as Record<string, unknown>;
			if (typeof input.command === "string") {
				input.command = `${buildClaudeEnvExports(active)}\n${input.command}`;
			}
			return undefined;
		}

		expandToolInputPlaceholders(event.input, active);
		return undefined;
	});

	pi.on("agent_end", () => {
		setActiveSkillContext(null);
	});

	pi.on("resources_discover", async (_event, _ctx) => {
		const pluginSkillPaths = resolvedPlugins.flatMap((p) => p.skillPaths);
		const allSkillPaths = [...pluginSkillPaths, ...claudeSkillPaths];
		if (allSkillPaths.length === 0) return undefined;
		return { skillPaths: allSkillPaths };
	});

	pi.on("session_shutdown", () => {
		setActiveSkillContext(null);
		if (hasRefcount && sessionCwd) {
			unlinkAgents(sessionCwd);
			hasRefcount = false;
		}
	});
}
