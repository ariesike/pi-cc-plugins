import { describe, it, expect } from "vitest";
import { parseSource, getCloneDir, getCacheBaseDir } from "../index.js";
import { join } from "node:path";

describe("getCacheBaseDir", () => {
	it("returns a path under XDG cache", () => {
		const dir = getCacheBaseDir();
		expect(dir).toMatch(/pi-cc-plugins$/);
	});
});

describe("getCloneDir", () => {
	it("resolves github source to owner--repo slug", () => {
		const source = parseSource("github:pleaseai/claude-code-plugins");
		const dir = getCloneDir(source);
		expect(dir).toBe(join(getCacheBaseDir(), "pleaseai--claude-code-plugins"));
	});

	it("resolves github source with subpath", () => {
		const source = parseSource("github:foo/bar#subpath=plugins/vue");
		const dir = getCloneDir(source);
		// Clone dir is always based on the repo, not subpath
		expect(dir).toBe(join(getCacheBaseDir(), "foo--bar"));
	});

	it("resolves git source to a slug from the URL", () => {
		const source = parseSource("git:github.com/user/repo");
		const dir = getCloneDir(source);
		expect(dir).toBe(join(getCacheBaseDir(), "github.com--user--repo"));
	});

	it("strips .git suffix from git URLs", () => {
		const source = parseSource("git:github.com/user/repo.git");
		const dir = getCloneDir(source);
		expect(dir).toBe(join(getCacheBaseDir(), "github.com--user--repo"));
	});

	it("returns empty string for local sources", () => {
		const source = parseSource("local:~/my-plugin");
		const dir = getCloneDir(source);
		expect(dir).toBe("");
	});
});
