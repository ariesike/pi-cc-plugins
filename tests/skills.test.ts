import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { resolve, join } from "node:path";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { normalizeSkillName, sanitizeSkillMarkdown, materializeStandaloneSkillPath } from "../src/skills.js";

describe("normalizeSkillName", () => {
	it("converts Claude skill names to Pi-compatible names", () => {
		expect(normalizeSkillName("posthog_user_sessions")).toBe("posthog-user-sessions");
		expect(normalizeSkillName(" Notion/Knowledge Capture ")).toBe("notion-knowledge-capture");
	});
});

describe("sanitizeSkillMarkdown", () => {
	it("quotes scalar frontmatter values that strict YAML would reject", () => {
		const result = sanitizeSkillMarkdown(`---
name: code-search
description: Use when: debugging, and do NOT use for: simple file reads
argument-hint: [repo-name] [branch-name]
---

# Code Search
`, "code-search");

		expect(result).toContain('name: "code-search"');
		expect(result).toContain('description: "Use when: debugging, and do NOT use for: simple file reads"');
		expect(result).toContain('argument-hint: "[repo-name] [branch-name]"');
		expect(result).toContain("# Code Search");
	});

	it("normalizes invalid skill names", () => {
		const result = sanitizeSkillMarkdown(`---
name: posthog_user_sessions
description: Get sessions
---
Body
`, "posthog");

		expect(result).toContain('name: "posthog-user-sessions"');
	});

	it("preserves booleans and block scalar frontmatter", () => {
		const result = sanitizeSkillMarkdown(`---
name: data-search
user-invocable: false
description: |
  Use when: production data helps.
  Do NOT use for: code exploration.
---
Body
`, "data-search");

		expect(result).toContain("user-invocable: false");
		expect(result).toContain("description: |\n  Use when: production data helps.");
	});
});

describe("materializeStandaloneSkillPath", () => {
	const tmpDir = join(homedir(), ".pi-cc-plugins-test-skills-tmp");

	beforeEach(() => {
		mkdirSync(tmpDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("copies skill dir to cache and sanitizes SKILL.md", () => {
		const rootDir = join(tmpDir, "skills-root");
		const skillDir = join(rootDir, "my-skill");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(
			join(skillDir, "SKILL.md"),
			"---\nname: my-skill\ndescription: Use when: testing\n---\n\n# Test\n",
		);

		const result = materializeStandaloneSkillPath(
			"claude-global",
			"~/.claude/skills",
			rootDir,
			skillDir,
		);

		expect(existsSync(result)).toBe(true);
		expect(existsSync(join(result, "SKILL.md"))).toBe(true);

		const content = readFileSync(join(result, "SKILL.md"), "utf-8");
		expect(content).toContain('name: "my-skill"');
		expect(content).toContain('description: "Use when: testing"');
	});

	it("uses namespace and sourceId for cache path isolation", () => {
		const rootDir1 = join(tmpDir, "root1");
		const skillDir1 = join(rootDir1, "skill-a");
		mkdirSync(skillDir1, { recursive: true });
		writeFileSync(join(skillDir1, "SKILL.md"), "---\nname: a\n---\n\nA\n");

		const rootDir2 = join(tmpDir, "root2");
		const skillDir2 = join(rootDir2, "skill-a");
		mkdirSync(skillDir2, { recursive: true });
		writeFileSync(join(skillDir2, "SKILL.md"), "---\nname: a\n---\n\nA2\n");

		const result1 = materializeStandaloneSkillPath("claude-global", "~/.claude/skills", rootDir1, skillDir1);
		const result2 = materializeStandaloneSkillPath("claude-project", ".claude/skills", rootDir2, skillDir2);

		// Different namespaces → different cache paths
		expect(result1).not.toBe(result2);
	});
});
