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
4. Skill directories are copied into `~/.cache/pi-cc-plugins/skills/`, where copied `SKILL.md` frontmatter is normalized for Pi's stricter YAML and skill-name validation
5. These cached skill paths are contributed to Pi via the `resources_discover` event
6. Pi loads them as native skills — they appear in `/skills` and work like any other Pi skill

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

## Standalone `.claude/skills`

In addition to loading skills from plugin repos, this extension can load standalone Claude Code skills from your global or project `.claude/skills` directories. These skills go through the same frontmatter sanitization as plugin skills, ensuring Pi can parse them correctly.

### Settings

Add either or both settings to your Pi settings file:

```jsonc
// ~/.pi/agent/settings.json or .pi/settings.json
{
  "ccClaudeSkillsGlobal": true,   // load skills from ~/.claude/skills/
  "ccClaudeSkillsProject": true   // load skills from <project>/.claude/skills/
}
```

Both default to `false` (opt-in) to avoid conflicts with Pi's native `skills` setting if you're already using it to point at `.claude/skills`.

### How It Works

1. On startup, the extension checks the `ccClaudeSkillsGlobal` and `ccClaudeSkillsProject` settings
2. For each enabled setting, it scans the corresponding `.claude/skills/` directory for subdirectories containing `SKILL.md` files
3. Discovered skill directories are copied to the cache with sanitized frontmatter (same as plugin skills)
4. The cached skill paths are contributed to Pi via `resources_discover`
5. Pi loads them as native skills

### Directory Structure

```
~/.claude/skills/          # global (ccClaudeSkillsGlobal)
  my-global-skill/
    SKILL.md

<project>/.claude/skills/  # project (ccClaudeSkillsProject)
  my-project-skill/
    SKILL.md
```

### Relationship to Pi's Native `skills` Setting

Pi has a built-in `skills` setting that can point at arbitrary directories:

```json
{
  "skills": ["~/.claude/skills"]
}
```

However, Pi loads those skills as-is without any frontmatter sanitization. Claude Code `SKILL.md` files often use loose YAML (unquoted strings with colons, underscores in names) that Pi's strict YAML parser rejects. Using `ccClaudeSkillsGlobal`/`ccClaudeSkillsProject` instead ensures the frontmatter is normalized automatically.

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
- Materialized skills are cached separately in `~/.cache/pi-cc-plugins/skills/`
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
