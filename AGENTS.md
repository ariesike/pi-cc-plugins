# pi-cc-plugins — Agent Guide

## What This Project Does

A [Pi](https://pi.dev) extension that bridges [Claude Code](https://code.claude.com) plugins into Pi. It reads plugin source references from Pi settings, clones remote repos into a local cache, discovers `SKILL.md` files inside them, and exposes those skills to Pi via the `resources_discover` event.

**Current scope:** Only plugin **skills** are supported — commands, agents, hooks, MCP servers, etc. are not yet supported.

## Architecture

```
index.ts          Entry point — registers Pi extension hooks
src/
  types.ts        Shared types (ParsedSource, ResolvedPlugin) and SOURCE_TYPES constant map
  source.ts       Parses source strings (github:..., git:..., local:...) into ParsedSource
  settings.ts     Reads ccPlugins array from merged Pi settings (global + project)
  cache.ts        Git cloning + cache management under ~/.cache/pi-cc-plugins/
  plugin.ts       Resolves a ParsedSource into a ResolvedPlugin, discovers skill paths
  index.ts        Barrel re-exports of all public API
tests/            Vitest tests with fixtures
```

### Flow

1. `session_start` → `readCcPlugins()` reads merged settings
2. Each source string → `parseSource()` → `resolvePlugin()`
3. Remote sources → `ensureCloned()` (shallow clone into XDG cache)
4. `discoverSkillPaths()` walks plugin dirs for `SKILL.md` files
5. `resources_discover` → returns flat list of skill paths to Pi

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
