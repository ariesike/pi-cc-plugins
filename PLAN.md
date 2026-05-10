# Plan: pi-cc-plugins — Claude Code Plugins for Pi

## Context

Pi and Claude Code both use `SKILL.md` files as their skill format. This package creates a Pi extension that bridges Claude Code's plugin/marketplace ecosystem into Pi. For the initial version, we only support **plugin skills** — commands, agents, hooks, MCP servers, etc. are out of scope.

The extension reads plugin configuration from Pi's `settings.json`, clones the plugin repositories (if not already cached), and exposes their `skills/` directories to Pi via the `resources_discover` event.

## Approach

### How It Works

1. **Configuration** — User defines plugins in Pi's `settings.json` (global or project-level) as source strings. This is the source of truth.
2. **Installation** — On `session_start`, the extension reads the config and clones missing plugin repos into a cache directory (skips if already cached).
3. **Discovery** — On `resources_discover`, the extension returns the `skills/` paths from all configured plugins so Pi picks up their `SKILL.md` files natively.
4. **Settings Sync** — The extension only contributes skills for plugins present in the current settings. If a plugin is removed from settings, its skills stop being discovered (no uninstall needed — just remove from config).

### Settings Schema

Added to Pi's `settings.json` — just a list of plugin sources. No marketplaces, no names. The plugin's own `.claude-plugin/plugin.json` provides the name.

```jsonc
{
  "ccPlugins": [
    // Pi git syntax — clones the whole repo, uses its skills/
    "github:pleaseai/claude-code-plugins",

    // With subpath — clones the repo, uses a specific subdirectory as the plugin root
    "github:pleaseai/claude-code-plugins#subpath=plugins/vue",

    // Full git URL
    "git:github.com/user/custom-cc-plugin",

    // Local path (for development)
    "local:~/my-plugins/my-plugin"
  ]
}
```

Each entry is a string in Pi's source syntax. Optional `#subpath=<path>` suffix points to a specific directory within the repo to use as the plugin root (useful when a repo contains multiple plugins or a marketplace structure).

### Plugin Installation Flow

For each entry in `ccPlugins`:
1. Parse the source string to determine the type (`github:`, `git:`, `local:`) and optional `#subpath=`
2. For `local:` sources — resolve the path and use directly (no cloning)
3. For `github:` and `git:` sources — clone the repo into the cache dir if not already present
4. Determine the plugin root directory (repo root, or subpath if `#subpath=` is specified)
5. Read `.claude-plugin/plugin.json` from the plugin root to get the plugin name (used as cache dir name)
6. Scan the plugin root for a `skills/` directory

Cache directory: `~/.cache/pi-cc-plugins/` (XDG-compliant)
Each cloned repo is stored as `~/.cache/pi-cc-plugins/<owner>--<repo>/` (using `--` as separator to avoid conflicts)

### Claude Code Plugin Structure (what we consume)

```
my-plugin/
├── .claude-plugin/
│   └── plugin.json       # manifest (name is required)
└── skills/
    ├── code-reviewer/
    │   └── SKILL.md      # Pi-compatible format (frontmatter + body)
    └── pdf-processor/
        └── SKILL.md
```

Pi's `SKILL.md` format and Claude Code's `SKILL.md` format are compatible — both use YAML frontmatter with `name` and `description`, followed by markdown instructions. The extension just needs to point Pi at the right directories.

## Files to Create

| File | Purpose |
|------|---------|
| `package.json` | Pi package manifest with extension entry point |
| `index.ts` | Extension — reads settings, installs plugins, contributes skill paths |
| `README.md` | Usage and configuration docs |
| `LICENSE` | MIT license (matching pi-save) |
| `.github/workflows/publish.yml` | Semantic release CI (matching pi-save) |
| `.releaserc.json` | Semantic release config (matching pi-save) |
| `.gitignore` | Standard ignores |

## Reuse

From **pi-save** (exact patterns to replicate):
- `package.json` structure — `pi.extensions` field, `pi-package`/`pi-extension` keywords, peerDependencies, semantic-release devDeps
- `.github/workflows/publish.yml` — identical CI pipeline
- `.releaserc.json` — identical release config
- `.gitignore` — identical

From **Pi extension API** (`@earendil-works/pi-coding-agent`):
- `pi.on("session_start")` — trigger plugin installation/sync on startup
- `pi.on("resources_discover")` — contribute `skillPaths` from installed plugins
- `ctx.ui.notify()` — user notifications for install/sync status

From **Claude Code plugin spec**:
- `.claude-plugin/plugin.json` — plugin manifest (name is the only required field; optional `skills` path override)
- `skills/*/SKILL.md` — skill definitions (Pi-compatible frontmatter format)

## Steps

- [x] Initialize project: `package.json`, `.gitignore`, `.releaserc.json`
- [x] Implement `index.ts` extension:
  - [x] Read `ccPlugins` array from Pi settings
  - [x] Define cache directory path (`~/.cache/pi-cc-plugins/`, XDG-compliant)
  - [x] Implement source string parsing (extract type, repo, optional `#subpath=`)
  - [x] Implement git clone logic for `github:` and `git:` sources (clone only if not present, no pull/update)
  - [x] Handle `local:` sources by resolving the path directly (no cloning)
  - [x] Implement skill path discovery (scan plugin dirs for `skills/` subdirectories)
  - [x] Wire up `session_start` handler: validate config, clone missing plugins (skip if already cached, no updates)
  - [x] Wire up `resources_discover` handler: return `skillPaths` from all installed plugins
  - [x] Add error handling and user notifications (network failures, missing plugins, etc.)
- [x] Add test suite (`tests/` directory with vitest):
  - [x] Unit tests for source string parsing (`parseSource`)
  - [x] Unit tests for skill path discovery (`discoverSkillPaths`)
  - [x] Unit tests for cache dir resolution (`getCacheDir`)
  - [x] Integration test for git clone flow (clone a real small repo)
  - [x] Integration test for full extension lifecycle (session_start → resources_discover)
- [x] Write `README.md` with configuration examples and usage
- [x] Add `LICENSE` (MIT)
- [x] Add `.github/workflows/publish.yml` and `.releaserc.json`
- [ ] Test end-to-end: configure a plugin source, verify skills load in Pi

## Verification

1. Install the package: `pi install git:git@github.com:asermax/pi-cc-plugins`
2. Add a plugin source to `~/.pi/agent/settings.json`: `"ccPlugins": ["github:pleaseai/claude-code-plugins"]`
3. Start `pi` — extension should clone the plugin repo and log status
4. Run `/skills` or check that plugin skills are available as slash commands
5. Test with `#subpath=`: `"github:pleaseai/claude-code-plugins#subpath=plugins/vue"`
6. Remove a plugin from settings → restart → skills should no longer appear
