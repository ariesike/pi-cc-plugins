# pi-cc-plugins — Agent Guide

## What This Project Does

A [Pi](https://pi.dev) extension that bridges [Claude Code](https://code.claude.com) plugins into Pi. It reads plugin source references from Pi settings, clones remote repos into a local cache, discovers `SKILL.md` files, agent `.md` files, and MCP configs inside them, and makes them available to Pi.

**Supported plugin components:**
- **Skills** — `SKILL.md` files exposed via Pi's `resources_discover` event
- **Agents** — `.md` files from `agents/` directories, converted to pi-subagents format and symlinked into `.pi/agents/cc-plugins/`
- **MCP servers** — `mcp.json`, `.mcp.json`, or manifest-declared MCP configs merged into project `.pi/mcp.json` for pi-mcp-adapter

**Requirements for agents:** [pi-subagents](https://github.com/nicobailon/pi-subagents) must be installed. If it's not found in Pi's `packages` settings, agent loading is skipped with a warning.
**Requirements for MCP:** [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter) must be installed. If plugin MCP configs are found without it, MCP loading is skipped with a warning.

## Architecture

```
index.ts          Entry point — registers Pi extension hooks
src/
  types.ts        Shared types (ParsedSource, ResolvedPlugin, ParsedAgent) and SOURCE_TYPES constant map
  source.ts       Parses source strings (github:..., git:..., local:...) into ParsedSource
  settings.ts     Reads ccPlugins array from merged Pi settings (global + project)
  cache.ts        Git cloning + cache management under ~/.cache/pi-cc-plugins/
  plugin.ts       Resolves a ParsedSource into a ResolvedPlugin, discovers skill + agent + MCP config paths
  agents.ts       Agent parsing, format conversion, caching, and symlink management
  mcp.ts          MCP config parsing, namespacing, project merge, and sidecar management
  index.ts        Barrel re-exports of all public API
tests/            Vitest tests with fixtures
```

### Flow

#### Skills
1. `session_start` → `readCcPlugins()` reads merged settings
2. Each source string → `parseSource()` → `resolvePlugin()`
3. Remote sources → `ensureCloned()` (shallow clone into XDG cache)
4. `discoverSkillPaths()` walks plugin dirs for `SKILL.md` files
5. `resources_discover` → returns flat list of skill paths to Pi

#### Agents
1. `session_start` → check `isSubagentsInstalled()` via Pi settings `packages` array
2. If installed: `discoverAgentPaths()` walks plugin `agents/` dirs for `.md` files
3. Each agent → `parseCcAgent()` → `convertCcAgent()` → `writeCachedAgent()` to `~/.cache/pi-cc-plugins/agents/{slug}/`
4. `incrementRefcount()` → `cleanupStaleSymlinks()` → `linkAgents()` creates symlinks in `{project}/.pi/agents/cc-plugins/`
5. pi-subagents discovers agents via its recursive `.pi/agents/` scan (follows symlinks)
6. `session_shutdown` → `decrementRefcount()` → removes symlinks when count reaches 0

#### MCP servers
1. `session_start` → check `isMcpAdapterInstalled()` via Pi settings `packages` array when plugin MCP configs are present
2. `discoverMcpConfigPaths()` checks `mcp.json`, `.mcp.json`, then `.claude-plugin/plugin.json` `mcp`
3. `collectPluginMcpServers()` reads only object-shaped `mcpServers` / `mcp-servers` entries; top-level settings/imports are ignored
4. Servers are namespaced as `{plugin-name}__{server-name}` and merged into `{project}/.pi/mcp.json`
5. Managed entries are tracked in `{project}/.pi/mcp.cc-plugins.json` so stale entries can be removed on later `session_start`
6. Existing user MCP servers win on collision with generated plugin names

### Agent format conversion

Claude Code plugin agents use simple YAML frontmatter. The converter maps:

| CC field | pi-subagents field | Notes |
|---|---|---|
| `name` | `name` | Direct |
| — | `package` | Set to plugin name for namespacing |
| `description` | `description` | Direct |
| `model` | — | Dropped |
| `tools` | — | Dropped |
| `skills` | `skills` | Pass-through |
| — | `systemPromptMode` | Default `append` |
| — | `inheritProjectContext` | Default `true` |
| — | `inheritSkills` | Default `true` |

### Reference counting

Multiple Pi sessions in the same project can use agents concurrently. A `.cc-plugins-refcount` file in `.pi/agents/cc-plugins/` tracks active sessions. Symlinks and the directory are only removed when the count reaches 0 on `session_shutdown`.

MCP entries are not removed on `session_shutdown`; they stay in project `.pi/mcp.json` so pi-mcp-adapter can read them on the next startup. Stale managed entries are cleaned on `session_start` using `.pi/mcp.cc-plugins.json`.

## Conventions

- **Language:** TypeScript, ESM (`"type": "module"`)
- **Runtime:** Node.js — no build step, Pi loads `.ts` directly
- **No enums:** Uses `const` maps + `type` derivation (see `SOURCE_TYPES` in `types.ts`)
- **Testing:** Vitest — run with `npm test` or `npm run test:watch`
- **Null checks:** Use `== null` for null/undefined, `===` otherwise
- **Error handling:** Throw descriptive errors with the raw source string included for debugging

## Common Actions

### Run tests

```bash
npm test
```

### Run tests in watch mode

```bash
npm run test:watch
```

### Release

Uses [semantic-release](https://semantic-release.gitbook.io) on CI. Push conventional commits to `main`:

- `feat:` → minor bump
- `fix:` → patch bump
- `feat!:` or `BREAKING CHANGE:` in footer → major bump

No manual versioning or tagging.

### Add a new source type

1. Add the type key to `SOURCE_TYPES` in `src/types.ts`
2. Add a slugifier for it in `slugify` map in `src/cache.ts`
3. Handle resolution logic in `resolvePlugin()` in `src/plugin.ts`
4. Update `parseSource()` in `src/source.ts` if parsing needs change
5. Add tests in `tests/parse-source.test.ts`

### Add a new feature

Follow the existing module pattern: logic in a dedicated file under `src/`, types in `src/types.ts`, re-export from `src/index.ts` and the root `index.ts`, tests in `tests/`.
