# pi-cc-plugins

Use [Claude Code](https://code.claude.com) plugins (skills, agents, and MCP servers) directly in [Pi](https://pi.dev).

This extension bridges Claude Code's plugin ecosystem into Pi. It reads source references from your settings, clones remote repos into a local cache, and exposes the **skills**, **agents**, and **MCP configs** found inside them so Pi loads them natively.

> **Fork notice:** This project has been forked and modified.

## Install

```bash
pi install npm:@asermax/pi-cc-plugins
```

Or from git:

```bash
pi install git:git@github.com:asermax/pi-cc-plugins.git
```

## Sources

Resources can come from three kinds of sources: **plugins** (remote or local repos), **session-only plugin directories** passed on the command line, and **standalone `.claude` directories** (global or per-project).

### Session-only `--plugin-dir`

Like Claude Code's `--plugin-dir`, Pi can load a Claude Code plugin directory for the current session only:

```bash
pi --plugin-dir ~/my-plugins/dev-plugin
pi --plugin-dir ~/plugins/a --plugin-dir ~/plugins/b
```

The flag is repeatable. Each directory is scanned with the same plugin rules as `ccPlugins`, so its `skills/`, `agents/`, and MCP config files are discovered without adding anything to settings.

### Plugins

Add a `ccPlugins` array to your Pi settings (`~/.pi/agent/settings.json` for global, or `.pi/settings.json` for project-level):

```jsonc
{
  "ccPlugins": [
    // Clone a GitHub repo and use its skills/, agents/, and MCP configs
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

#### Source Formats

| Format | Example | Description |
|--------|---------|-------------|
| `github:owner/repo` | `github:pleaseai/claude-code-plugins` | Clones from GitHub |
| `github:owner/repo#subpath=dir` | `github:foo/bar#subpath=plugins/vue` | Clones from GitHub, uses subdirectory as plugin root |
| `git:<url>` | `git:github.com/user/repo` | Clones from any git URL |
| `local:<path>` | `local:~/my-plugins/dev-plugin` | Uses a local directory directly (no cloning) |

#### Expected Plugin Structure

Plugins follow Claude Code's standard layout:

```
my-plugin/
├── .claude-plugin/
│   └── plugin.json       # manifest with "name" field
├── skills/
│   ├── code-reviewer/
│   │   └── SKILL.md
│   └── pdf-processor/
│       └── SKILL.md
├── agents/
│   └── security-scanner.md
└── mcp.json              # optional MCP server config
```

If `plugin.json` declares custom paths, they are respected:

```json
{
  "name": "my-plugin",
  "skills": "./custom-skills-dir",
  "agents": "./custom-agents-dir",
  "mcp": "./custom-mcp.json"
}
```

### Standalone `.claude` Directories

In addition to plugins, the extension can load resources from your global or project `.claude` directories. Enable them in settings:

```jsonc
// ~/.pi/agent/settings.json or .pi/settings.json
{
  "ccClaudeGlobal": true,   // load ~/.claude/skills/ and ~/.claude/agents/
  "ccClaudeProject": true   // load <project>/.claude/skills/ and <project>/.claude/agents/
}
```

Both default to `false` (opt-in). This avoids conflicts with Pi's native `skills` setting if you're already pointing it at `.claude/skills`.

#### Directory Structure

```
~/.claude/skills/          # global (ccClaudeGlobal)
  my-global-skill/
    SKILL.md
~/.claude/agents/          # global (ccClaudeGlobal)
  my-global-agent.md

<project>/.claude/skills/  # project (ccClaudeProject)
  my-project-skill/
    SKILL.md
<project>/.claude/agents/  # project (ccClaudeProject)
  my-project-agent.md
```

## Skills

Skills are `SKILL.md` files that teach Pi how to handle specific tasks. They are discovered automatically from all configured sources.

### Discovery

1. On startup, the extension reads `--plugin-dir`, your `ccPlugins`, and the `ccClaudeGlobal`/`ccClaudeProject` settings
2. Remote plugins are shallow-cloned into `~/.cache/pi-cc-plugins/` (if not already cached)
3. Each source is scanned for `skills/` directories containing `SKILL.md` files
4. Skill directories are copied into `~/.cache/pi-cc-plugins/skills/` with normalized frontmatter
5. Cached skill paths are contributed to Pi via the `resources_discover` event
6. Pi loads them as native skills — they appear in `/skills` and work like any other Pi skill

### Claude Code Skill Environment

When a Claude Code skill from a plugin is loaded (for example via `/skill:name` or when the agent reads its `SKILL.md`), the extension tracks the active skill context and injects Claude-compatible environment variables:

- `CLAUDE_PLUGIN_ROOT` → the original plugin root directory
- `CLAUDE_SKILL_DIR` → the original skill directory

Bash tool calls are prefixed with these exports, and non-Bash tool arguments can use `$CLAUDE_PLUGIN_ROOT`, `${CLAUDE_PLUGIN_ROOT}`, `$CLAUDE_SKILL_DIR`, or `${CLAUDE_SKILL_DIR}` placeholders.

### Frontmatter Sanitization

Claude Code `SKILL.md` files often use loose YAML (unquoted strings with colons, underscores in names) that Pi's stricter YAML parser rejects. The extension normalizes frontmatter during caching so skills load reliably.

Because of this, **use `ccClaudeGlobal`/`ccClaudeProject` instead of Pi's native `skills` setting** when you want to load skills from `.claude/skills`. Pi's native `skills` setting loads files as-is without sanitization:

```json
{
  // ❗ Use this (with sanitization):
  "ccClaudeGlobal": true,
  // ⚠️ Not this (no sanitization, may fail to parse):
  "skills": ["~/.claude/skills"]
}
```

## Agents

Plugin agents and standalone `.claude/agents` are converted to [pi-subagents](https://github.com/nicobailon/pi-subagents) format and made available as project-level agents.

### Requirements

**pi-subagents must be installed.** If it's not in your Pi `packages` list, agent loading is skipped with a warning.

```bash
pi install npm:pi-subagents
```

### Discovery

1. On `session_start`, the extension checks that `pi-subagents` is installed
2. It scans each plugin's `agents/` directory and enabled `.claude/agents/` directories for `.md` files
3. Each agent is parsed from Claude Code format and converted to pi-subagents format
4. Converted agents are cached in `~/.cache/pi-cc-plugins/agents/`
5. Symlinks are created in `{project}/.pi/agents/cc-plugins/` pointing to the cached files
6. pi-subagents discovers them via its recursive `.pi/agents/` scan (it follows symlinks)
7. On `session_shutdown`, symlinks are cleaned up (reference-counted for concurrent sessions)

### Format Conversion

Claude Code agents use YAML frontmatter. The converter maps fields to pi-subagents format:

| CC field | pi-subagents field | Notes |
|----------|--------------------|-------|
| `name` | `name` | Direct |
| — | `package` | Set to plugin name (namespacing) |
| `description` | `description` | Direct |
| `model` | — | Dropped — CC model names don't reliably match Pi identifiers |
| `tools` | — | Dropped — CC tool names don't reliably match Pi tool identifiers |
| `skills` | `skills` | Pass-through |
| — | `systemPromptMode` | Default `append` |
| — | `inheritProjectContext` | Default `true` |
| — | `inheritSkills` | Default `true` |

#### Example

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

### Using Agents

Once loaded, converted agents appear in pi-subagents:

```text
subagent({ action: "list" })
```

Plugin agents show up as `{plugin-name}.{agent-name}`. Standalone Claude agents use `claude-global.{agent-name}` or `claude-project.{agent-name}`.

### Reference Counting

If multiple Pi sessions are open in the same project, agent symlinks are reference-counted. A `.cc-plugins-refcount` file in `.pi/agents/cc-plugins/` tracks active sessions. Symlinks and the directory are only removed when the count reaches 0 on `session_shutdown`.

## MCP Servers

Plugin MCP configs can be exposed through [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter) when that extension is installed. MCP configs are only loaded from plugins — standalone `.claude` directories are not scanned for MCP.

### Requirements

**pi-mcp-adapter must be installed.** If plugin MCP configs are found but the adapter is missing, MCP loading is skipped with a warning.

```bash
pi install npm:pi-mcp-adapter
```

### Config Locations

For each plugin, the extension checks these files in order:

1. `mcp.json`
2. `.mcp.json`
3. The path from `.claude-plugin/plugin.json`'s `mcp` field, resolved relative to the plugin root

If multiple files define the same server name, later files in that order win before namespacing.

### How It Works

1. On `session_start`, the extension scans plugin MCP configs after resolving `ccPlugins`
2. Only object-shaped `mcpServers` / `mcp-servers` entries are imported (top-level `settings`, `imports`, and unknown fields are ignored)
3. Servers are written to `{project}/.pi/mcp.json`, which pi-mcp-adapter already reads
4. Managed entries are tracked in `{project}/.pi/mcp.cc-plugins.json` so stale plugin servers can be removed on the next startup

Server names are namespaced as `{plugin-name}__{server-name}`. For example, a `chrome-devtools` server from `my-plugin` becomes `my-plugin__chrome-devtools`.

MCP server definitions may use Claude Code path placeholders. Before writing to `.pi/mcp.json`, the extension expands `$CLAUDE_PLUGIN_ROOT` / `${CLAUDE_PLUGIN_ROOT}` to the source plugin root. `$CLAUDE_SKILL_DIR` / `${CLAUDE_SKILL_DIR}` is expanded when the MCP config file lives inside a plugin skill directory. The generated MCP server `env` also includes `CLAUDE_PLUGIN_ROOT`, and includes `CLAUDE_SKILL_DIR` when a skill directory can be inferred.

User-owned entries in `.pi/mcp.json` are preserved. If a generated plugin server name collides with an existing user server, the plugin server is skipped with a warning.

MCP entries are not removed on `session_shutdown` — they stay in `.pi/mcp.json` so pi-mcp-adapter can read them on the next startup. If plugin MCP config is added for the first time during a running session, pi-mcp-adapter may need a reload or restart to pick it up.

## Cache

All cached data lives under `~/.cache/pi-cc-plugins/` (respects `$XDG_CACHE_HOME`):

| Path | Contents |
|------|----------|
| `skills/{plugin-name}/` | Cloned plugin repos |
| `skills/{slug}/` | Materialized skills with normalized frontmatter |
| `agents/{slug}/` | Converted agent files |

Plugins are cloned once — subsequent sessions reuse the cached clone. To force a re-clone, delete the plugin's directory from the cache.

## Removing Plugins

Remove the entry from your `ccPlugins` array in settings. On the next session start, stale agent symlinks and managed MCP entries are cleaned up, and skills will no longer be discovered. The cached clone remains on disk until you delete it manually.

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
