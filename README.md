# pi-cc-plugins

Use [Claude Code](https://code.claude.com) plugins (skills & agents) directly in [Pi](https://pi.dev).

This extension bridges Claude Code's plugin ecosystem into Pi by reading plugin sources from your settings, cloning their repos into a local cache, and exposing their **skills** and **agents** so Pi loads them natively.

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
    // Clone a GitHub repo and use its skills/ and agents/
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

## Skills

Skills are discovered and loaded automatically for all configured plugins.

### How Skills Work

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
├── skills/
│   ├── code-reviewer/
│   │   └── SKILL.md
│   └── pdf-processor/
│       └── SKILL.md
└── agents/
    └── security-scanner.md
```

If the plugin's `plugin.json` specifies custom paths, they will be respected:

```json
{
  "name": "my-plugin",
  "skills": "./custom-skills-dir",
  "agents": "./custom-agents-dir"
}
```

## Agents

Plugin agents are converted to [pi-subagents](https://github.com/nicobailon/pi-subagents) format and made available as project-level agents.

### Requirements

- **pi-subagents must be installed** — if it's not in your Pi `packages` list, agent loading is skipped with a warning. Install it with:
  ```bash
  pi install npm:pi-subagents
  ```

### How Agents Work

1. On `session_start`, the extension checks if `pi-subagents` is installed
2. If installed, it scans each plugin's `agents/` directory for `.md` files
3. Each agent is parsed (Claude Code format) and converted to pi-subagents format
4. Converted agents are cached in `~/.cache/pi-cc-plugins/agents/`
5. Symlinks are created in `{project}/.pi/agents/cc-plugins/` pointing to the cached files
6. pi-subagents discovers them via its recursive `.pi/agents/` scan
7. On `session_shutdown`, symlinks are cleaned up (reference-counted for concurrent sessions)

### Agent Format

Claude Code plugin agents use YAML frontmatter:

```markdown
---
name: security-scanner
description: Scans code for security vulnerabilities
model: sonnet
tools: read, grep, find
skills: security-review
---

You are a security scanner. Analyze the code for vulnerabilities...
```

The converter maps these fields to pi-subagents format and adds defaults:

| Field | Mapping |
|-------|---------|
| `name` | Used directly; namespaced with `package: {plugin-name}` |
| `description` | Direct |
| `model` | Pass-through |
| `tools` | Pass-through |
| `skills` | Pass-through |
| *(default)* | `systemPromptMode: append`, `inheritProjectContext: true`, `inheritSkills: true` |

### Using Plugin Agents

Once loaded, plugin agents appear in pi-subagents:

```text
subagent({ action: "list" })
```

Plugin agents show up as `{plugin-name}.{agent-name}` (using the dotted package name format).

### Reference Counting

If multiple Pi sessions are open in the same project, agent symlinks are reference-counted. They are only removed when the last session shuts down.

### Cache

- Cached repos live in `~/.cache/pi-cc-plugins/` (respects `$XDG_CACHE_HOME`)
- Converted agents are cached separately in `~/.cache/pi-cc-plugins/agents/`
- Plugins are cloned once — subsequent sessions reuse the cached clone
- To force a re-clone, delete the plugin's directory from the cache

### Removing Plugins

Simply remove the entry from your `ccPlugins` array in settings. On the next session start, stale agent symlinks are cleaned up and skills will no longer be discovered. The cached clone remains on disk until you delete it manually.

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
