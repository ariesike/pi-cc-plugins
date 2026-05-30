/**
 * Barrel file — re-exports all public API from modules.
 */
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
} from "./types.js";
export { parseSource } from "./source.js";
export {
	parsePluginDirArgv,
	parsePluginDirFlagValue,
	resolvePluginDirArg,
	readPluginDirSources,
} from "./plugin-dir.js";
export {
	readCcPlugins,
	readCcClaudeGlobal,
	readCcClaudeProject,
	readPiPackages,
	isMcpAdapterInstalled,
	readJsonFile,
} from "./settings.js";
export {
	getCacheBaseDir,
	getCloneDir,
	ensureCloned,
	updateClone,
} from "./cache.js";
export {
	resolvePlugin,
	readPluginName,
	discoverSkillPaths,
	discoverAgentPaths,
	discoverMcpConfigPaths,
} from "./plugin.js";
export {
	materializeSkillPaths,
	materializePluginSkillPaths,
	materializeStandaloneSkillPath,
	walkSkillDir,
	sanitizeSkillMarkdown,
	normalizeSkillName,
} from "./skills.js";
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
} from "./agents.js";
export {
	getProjectMcpConfigPath,
	getProjectMcpSidecarPath,
	hasManagedMcpState,
	normalizeMcpName,
	readPluginMcpServers,
	collectPluginMcpServers,
	syncProjectMcpConfig,
} from "./mcp.js";
