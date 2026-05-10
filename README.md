# pi-cc-plugins

Use [Claude Code](https://code.claude.com) plugins (skills) directly in [Pi](https://pi.dev).

This extension bridges Claude Code's plugin ecosystem into Pi by reading plugin sources from your settings, cloning their repos into a local cache, and exposing their `skills/` directories so Pi loads them natively.

> **Scope:** This initial version only supports plugin **skills** — commands, agents, hooks, MCP servers, etc. are not supported yet.

## Install

```bash
pi install npm:@asermax/pi-cc-plugins
```

Or from git:

```bash
pi install git:git@github.com:asermax/pi-cc-plugins.git
```

## Configuration

Add a `ccPlugins` array to your Pi settings (`~/.pi/agent/settings.json` for global, or `.pi/settings.json` for project-level):

```jsonc
{
  "ccPlugins": [
    // Clone a GitHub repo and use its skills/
    "github:pleaseai/claude-code-plugins",

    // Clone a repo but use a specific subdirectory as the plugin root
    "github:pleaseai/claude-code-plugins#subpath=plugins/vue",

    // Full git URL
    "git:github.com/user/custom-cc-plugin",

    // Local path (great for development)
    "local:~/my-plugins/dev-plugin"
  ]
}
```

### Source Formats

| Format | Example | Description |
|--------|---------|-------------|
| `github:owner/repo` | `github:pleaseai/claude-code-plugins` | Clones from GitHub |
| `github:owner/repo#subpath=dir` | `github:foo/bar#subpath=plugins/vue` | Clones from GitHub, uses subdirectory as plugin root |
| `git:<url>` | `git:github.com/user/repo` | Clones from any git URL |
| `local:<path>` | `local:~/my-plugins/dev-plugin` | Uses a local directory directly (no cloning) |

### How It Works

1. On startup, the extension reads `ccPlugins` from your merged settings
2. For each source, it clones the repo into `~/.cache/pi-cc-plugins/` (if not already cached)
3. It scans each plugin for a `skills/` directory containing `SKILL.md` files
4. These skill paths are contributed to Pi via the `resources_discover` event
5. Pi loads them as native skills — they appear in `/skills` and work like any other Pi skill

### Plugin Requirements

The plugin must follow Claude Code's standard structure:

```
my-plugin/
├── .claude-plugin/
│   └── plugin.json       # manifest with "name" field
└── skills/
    ├── code-reviewer/
    │   └── SKILL.md
    └── pdf-processor/
        └── SKILL.md
```

If the plugin's `plugin.json` specifies a custom `skills` path, it will be respected:

```json
{
  "name": "my-plugin",
  "skills": "./custom-skills-dir"
}
```

### Cache

- Cached repos live in `~/.cache/pi-cc-plugins/` (respects `$XDG_CACHE_HOME`)
- Plugins are cloned once — subsequent sessions reuse the cached clone
- To force a re-clone, delete the plugin's directory from the cache

### Removing Plugins

Simply remove the entry from your `ccPlugins` array in settings. The skills will no longer be discovered on the next session start. The cached clone remains on disk until you delete it manually.

## Development

```bash
# Run tests
npm test

# Watch tests
npm run test:watch
```

### Release

This package uses [semantic-release](https://semantic-release.gitbook.io). Push conventional commits to `main`:

- `feat:` → minor bump
- `fix:` → patch bump
- `feat!:` or `BREAKING CHANGE:` in footer → major bump

No manual versioning or tagging needed — the CI handles it all.
