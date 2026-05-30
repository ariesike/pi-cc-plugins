import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

import {
	parsePluginDirArgv,
	parsePluginDirFlagValue,
	readPluginDirSources,
	resolvePluginDirArg,
} from "../src/plugin-dir.js";

describe("plugin-dir CLI helpers", () => {
	it("parses repeatable --plugin-dir argv values", () => {
		expect(
			parsePluginDirArgv([
				"node",
				"pi",
				"--plugin-dir",
				"plugins/a",
				"--plugin-dir=plugins/b",
				"--plugin-dir",
				"plugins/c",
			]),
		).toEqual(["plugins/a", "plugins/b", "plugins/c"]);
	});

	it("ignores non-string Pi flag values", () => {
		expect(parsePluginDirFlagValue(true)).toEqual([]);
		expect(parsePluginDirFlagValue(false)).toEqual([]);
		expect(parsePluginDirFlagValue(" ./plugin ")).toEqual(["./plugin"]);
	});

	it("resolves tilde and relative plugin-dir paths", () => {
		expect(resolvePluginDirArg("~/plugin", "/tmp/project")).toBe(
			join(homedir(), "plugin"),
		);
		expect(resolvePluginDirArg("./plugin", "/tmp/project")).toBe(
			resolve("/tmp/project", "plugin"),
		);
	});

	it("returns de-duplicated local sources from flag value and argv", () => {
		const cwd = "/tmp/project";
		expect(
			readPluginDirSources(cwd, "./plugin", [
				"node",
				"pi",
				"--plugin-dir",
				"./plugin",
				"--plugin-dir=./other",
			]),
		).toEqual([
			`local:${resolve(cwd, "plugin")}`,
			`local:${resolve(cwd, "other")}`,
		]);
	});
});
