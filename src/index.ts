/**
 * Barrel file — re-exports all public API from modules.
 */
export type { ParsedSource, ResolvedPlugin, ParsedAgent } from "./types.js";
export { parseSource } from "./source.js";
export { readCcPlugins, readJsonFile } from "./settings.js";
export { getCacheBaseDir, getCloneDir, ensureCloned } from "./cache.js";
export { resolvePlugin, readPluginName, discoverSkillPaths, discoverAgentPaths } from "./plugin.js";
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
