# pi-cc-plugins — Agent Guide

## What This Project Does

A [Pi](https://pi.dev) extension that bridges [Claude Code](https://code.claude.com) plugins into Pi. It reads plugin source references from Pi settings, clones remote repos into a local cache, discovers `SKILL.md` files and agent `.md` files inside them, and makes them available to Pi.

**Supported plugin components:**
- **Skills** — `SKILL.md` files exposed via Pi's `resources_discover` event
- **Agents** — `.md` files from `agents/` directories, converted to pi-subagents format and symlinked into `.pi/agents/cc-plugins/`

**Requirements for agents:** [pi-subagents](https://github.com/nicobailon/pi-subagents) must be installed. If it's not found in Pi's `packages` settings, agent loading is skipped with a warning.

## Architecture

```
index.ts          Entry point — registers Pi extension hooks
src/
  types.ts        Shared types (ParsedSource, ResolvedPlugin, ParsedAgent) and SOURCE_TYPES constant map
  source.ts       Parses source strings (github:..., git:..., local:...) into ParsedSource
  settings.ts     Reads ccPlugins array from merged Pi settings (global + project)
  cache.ts        Git cloning + cache management under ~/.cache/pi-cc-plugins/
  plugin.ts       Resolves a ParsedSource into a ResolvedPlugin, discovers skill + agent paths
  agents.ts       Agent parsing, format conversion, caching, and symlink management
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

### Agent format conversion

Claude Code plugin agents use simple YAML frontmatter. The converter maps:

| CC field | pi-subagents field | Notes |
|---|---|---|
| `name` | `name` | Direct |
| — | `package` | Set to plugin name for namespacing |
| `description` | `description` | Direct |
| `model` | `model` | Pass-through |
| `tools` | `tools` | Pass-through |
| `skills` | `skills` | Pass-through |
| — | `systemPromptMode` | Default `append` |
| — | `inheritProjectContext` | Default `true` |
| — | `inheritSkills` | Default `true` |

### Reference counting

Multiple Pi sessions in the same project can use agents concurrently. A `.cc-plugins-refcount` file in `.pi/agents/cc-plugins/` tracks active sessions. Symlinks and the directory are only removed when the count reaches 0 on `session_shutdown`.

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
