import { describe, it, expect } from "vitest";
import { parseSource } from "../index.js";

describe("parseSource", () => {
	// ---- github: sources ----

	it("parses a basic github source", () => {
		const result = parseSource("github:owner/repo");
		expect(result).toEqual({
			type: "github",
			ref: "owner/repo",
			subpath: undefined,
			raw: "github:owner/repo",
		});
	});

	it("parses a github source with subpath", () => {
		const result = parseSource("github:pleaseai/claude-code-plugins#subpath=plugins/vue");
		expect(result).toEqual({
			type: "github",
			ref: "pleaseai/claude-code-plugins",
			subpath: "plugins/vue",
			raw: "github:pleaseai/claude-code-plugins#subpath=plugins/vue",
		});
	});

	it("parses a github source with nested subpath", () => {
		const result = parseSource("github:foo/bar#subpath=a/b/c");
		expect(result.subpath).toBe("a/b/c");
	});

	it("throws for github source without slash", () => {
		expect(() => parseSource("github:noslash")).toThrow('Invalid github source');
	});

	// ---- git: sources ----

	it("parses a git source with full URL", () => {
		const result = parseSource("git:github.com/user/repo");
		expect(result).toEqual({
			type: "git",
			ref: "github.com/user/repo",
			subpath: undefined,
			raw: "git:github.com/user/repo",
		});
	});

	it("parses a git source with subpath", () => {
		const result = parseSource("git:github.com/user/repo#subpath=skills/foo");
		expect(result).toEqual({
			type: "git",
			ref: "github.com/user/repo",
			subpath: "skills/foo",
			raw: "git:github.com/user/repo#subpath=skills/foo",
		});
	});

	it("parses a git source with https URL", () => {
		const result = parseSource("git:https://example.com/repo.git");
		expect(result.ref).toBe("https://example.com/repo.git");
	});

	it("throws for empty git source", () => {
		expect(() => parseSource("git:")).toThrow('Invalid git source');
	});

	// ---- local: sources ----

	it("parses a local source with absolute path", () => {
		const result = parseSource("local:/absolute/path/to/plugin");
		expect(result).toEqual({
			type: "local",
			ref: "/absolute/path/to/plugin",
			subpath: undefined,
			raw: "local:/absolute/path/to/plugin",
		});
	});

	it("parses a local source with tilde", () => {
		const result = parseSource("local:~/my-plugins/dev-plugin");
		expect(result).toEqual({
			type: "local",
			ref: "~/my-plugins/dev-plugin",
			subpath: undefined,
			raw: "local:~/my-plugins/dev-plugin",
		});
	});

	it("parses a local source with relative path", () => {
		const result = parseSource("local:./plugins/my-plugin");
		expect(result.ref).toBe("./plugins/my-plugin");
	});

	it("throws for empty local source", () => {
		expect(() => parseSource("local:")).toThrow('Invalid local source');
	});

	// ---- unknown sources ----

	it("throws for unknown source format", () => {
		expect(() => parseSource("npm:some-package")).toThrow("Unknown source format");
		expect(() => parseSource("just-a-string")).toThrow("Unknown source format");
		expect(() => parseSource("")).toThrow("Unknown source format");
	});
});
