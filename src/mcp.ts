import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { normalizeSkillName } from "./skills.js";
import type {
	ManagedMcpEntry,
	ManagedMcpSidecar,
	McpServerEntry,
	McpSyncResult,
	PluginMcpServer,
	ResolvedPlugin,
} from "./types.js";

const MCP_CONFIG_PATH = ".pi/mcp.json";
const MCP_SIDECAR_PATH = ".pi/mcp.cc-plugins.json";

export function getProjectMcpConfigPath(projectRoot: string): string {
	return join(projectRoot, MCP_CONFIG_PATH);
}

export function getProjectMcpSidecarPath(projectRoot: string): string {
	return join(projectRoot, MCP_SIDECAR_PATH);
}

export function hasManagedMcpState(projectRoot: string): boolean {
	return existsSync(getProjectMcpSidecarPath(projectRoot));
}

export function normalizeMcpName(name: string, fallbackName: string): string {
	return normalizeSkillName(name, fallbackName);
}

export function readPluginMcpServers(configPath: string): { servers: Record<string, McpServerEntry>; warnings: string[] } {
	const raw = readJsonObject(configPath);
	const rawServers = raw.mcpServers ?? raw["mcp-servers"];
	const warnings: string[] = [];
	const servers: Record<string, McpServerEntry> = {};

	if (rawServers == null) return { servers, warnings };

	if (!isRecord(rawServers)) {
		return {
			servers,
			warnings: [`${configPath}: ignored non-object mcpServers`],
		};
	}

	for (const [name, definition] of Object.entries(rawServers)) {
		if (isRecord(definition)) {
			servers[name] = definition;
			continue;
		}

		warnings.push(`${configPath}: ignored non-object MCP server "${name}"`);
	}

	return { servers, warnings };
}

export function collectPluginMcpServers(plugins: ResolvedPlugin[]): { servers: PluginMcpServer[]; warnings: string[] } {
	const servers: PluginMcpServer[] = [];
	const warnings: string[] = [];
	const seenGeneratedNames = new Map<string, PluginMcpServer>();

	for (const plugin of plugins) {
		const byOriginalName = new Map<string, { definition: McpServerEntry; configPath: string }>();

		for (const configPath of plugin.mcpConfigPaths) {
			try {
				const parsed = readPluginMcpServers(configPath);
				warnings.push(...parsed.warnings);

				for (const [originalName, definition] of Object.entries(parsed.servers)) {
					byOriginalName.set(originalName, { definition, configPath });
				}
			} catch (err: any) {
				warnings.push(`${configPath}: ${err?.message || err}`);
			}
		}

		for (const [originalName, { definition, configPath }] of byOriginalName) {
			const generatedName = `${normalizeMcpName(plugin.name, "plugin")}__${normalizeMcpName(originalName, "server")}`;
			const server: PluginMcpServer = {
				pluginName: plugin.name,
				originalName,
				generatedName,
				definition,
				configPath,
			};
			const existing = seenGeneratedNames.get(generatedName);

			if (existing) {
				warnings.push(
					`MCP server "${generatedName}" from ${configPath} collides with ${existing.configPath}; keeping the first definition`,
				);
				continue;
			}

			seenGeneratedNames.set(generatedName, server);
			servers.push(server);
		}
	}

	return { servers, warnings };
}

export function syncProjectMcpConfig(projectRoot: string, plugins: ResolvedPlugin[]): McpSyncResult {
	const configPath = getProjectMcpConfigPath(projectRoot);
	const sidecarPath = getProjectMcpSidecarPath(projectRoot);
	const collected = collectPluginMcpServers(plugins);
	const sidecarExists = existsSync(sidecarPath);
	const previousSidecar = readManagedMcpSidecar(sidecarPath);

	if (collected.servers.length === 0 && previousSidecar.entries.length === 0 && !sidecarExists) {
		return {
			serverCount: 0,
			writtenCount: 0,
			changed: false,
			configPath,
			sidecarPath,
			warnings: collected.warnings,
		};
	}

	const rawConfig = readJsonObject(configPath, true);
	const mcpServers = getServersObject(rawConfig);
	const previousManagedNames = new Set(previousSidecar.entries.map((entry) => entry.name));
	const nextGeneratedNames = new Set(collected.servers.map((server) => server.generatedName));
	const nextManagedEntries: ManagedMcpEntry[] = [];
	const warnings = [...collected.warnings];

	for (const entry of previousSidecar.entries) {
		if (!nextGeneratedNames.has(entry.name)) {
			delete mcpServers[entry.name];
		}
	}

	for (const server of collected.servers) {
		if (hasOwn(mcpServers, server.generatedName) && !previousManagedNames.has(server.generatedName)) {
			warnings.push(`MCP server "${server.generatedName}" collides with an existing project MCP server; skipping plugin definition from ${server.configPath}`);
			continue;
		}

		mcpServers[server.generatedName] = server.definition;
		nextManagedEntries.push({
			name: server.generatedName,
			pluginName: server.pluginName,
			originalName: server.originalName,
			configPath: server.configPath,
		});
	}

	setServersObject(rawConfig, mcpServers);

	const nextSidecar: ManagedMcpSidecar = {
		version: 1,
		entries: nextManagedEntries,
	};
	const configChanged = writeJsonObjectIfChanged(configPath, rawConfig);
	const sidecarChanged = writeJsonObjectIfChanged(sidecarPath, nextSidecar);

	return {
		serverCount: collected.servers.length,
		writtenCount: nextManagedEntries.length,
		changed: configChanged || sidecarChanged,
		configPath,
		sidecarPath,
		warnings,
	};
}

function readManagedMcpSidecar(sidecarPath: string): ManagedMcpSidecar {
	try {
		const raw = readJsonObject(sidecarPath, true);
		if (raw.version !== 1 || !Array.isArray(raw.entries)) {
			return { version: 1, entries: [] };
		}

		return {
			version: 1,
			entries: raw.entries.filter(isManagedMcpEntry),
		};
	} catch {
		return { version: 1, entries: [] };
	}
}

function isManagedMcpEntry(value: unknown): value is ManagedMcpEntry {
	return isRecord(value)
		&& typeof value.name === "string"
		&& typeof value.pluginName === "string"
		&& typeof value.originalName === "string"
		&& typeof value.configPath === "string";
}

function getServersObject(raw: Record<string, unknown>): Record<string, McpServerEntry> {
	const existing = raw.mcpServers ?? raw["mcp-servers"] ?? {};
	if (!isRecord(existing)) return {};

	const servers: Record<string, McpServerEntry> = {};
	for (const [name, definition] of Object.entries(existing)) {
		if (isRecord(definition)) servers[name] = definition;
	}
	return servers;
}

function setServersObject(raw: Record<string, unknown>, servers: Record<string, McpServerEntry>): void {
	delete raw["mcp-servers"];
	raw.mcpServers = servers;
}

function readJsonObject(filePath: string, emptyWhenMissing = false): Record<string, unknown> {
	if (!existsSync(filePath)) {
		if (emptyWhenMissing) return {};
		throw new Error("file does not exist");
	}

	const raw = JSON.parse(readFileSync(filePath, "utf-8"));
	if (!isRecord(raw)) {
		throw new Error("expected a JSON object");
	}

	return raw;
}

function writeJsonObjectIfChanged(filePath: string, raw: unknown): boolean {
	const nextText = `${JSON.stringify(raw, null, 2)}\n`;
	const currentText = existsSync(filePath) ? readFileSync(filePath, "utf-8") : "";

	if (currentText === nextText) return false;

	mkdirSync(dirname(filePath), { recursive: true });
	const tmpPath = `${filePath}.${process.pid}.tmp`;
	writeFileSync(tmpPath, nextText, "utf-8");
	renameSync(tmpPath, filePath);
	return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(value, key);
}
