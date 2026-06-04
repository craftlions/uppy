import { describe, expect, it, vi } from "vitest";
import { renderDependencies } from "../src/deps.ts";
import { fetchOutdated, resolveUpdate } from "../src/outdated.ts";

const getVersionsBatch = vi.hoisted(() => vi.fn());
vi.mock("fast-npm-meta", () => ({ getVersionsBatch }));

describe("resolveUpdate", () => {
	it("bumps a stable version to the newest stable release", () => {
		expect(
			resolveUpdate("1.2.0", ["1.2.0", "1.2.1", "1.3.0"], "1.3.0"),
		).toEqual({ current: "1.2.0", target: "1.3.0", updateType: "minor" });
	});

	it("returns null when already on the latest stable", () => {
		expect(resolveUpdate("1.3.0", ["1.2.0", "1.3.0"], "1.3.0")).toBeNull();
	});

	it("ignores prerelease releases for a stable current version", () => {
		expect(resolveUpdate("1.2.0", ["1.2.0", "1.3.0-rc.1"], "1.2.0")).toBeNull();
	});

	it("does not jump unstable tracks: rc current goes to the stable release only", () => {
		// Renovate's documented example: on 4.0.0-rc.2 with 4.0.0 and
		// 4.1.0-alpha.1 available, the update is to 4.0.0 only.
		expect(
			resolveUpdate(
				"4.0.0-rc.2",
				["4.0.0-rc.2", "4.0.0-rc.3", "4.0.0", "4.1.0-alpha.1"],
				"4.0.0",
			),
		).toEqual({ current: "4.0.0-rc.2", target: "4.0.0", updateType: "major" });
	});

	it("allows a newer prerelease of the same base for an unstable current", () => {
		expect(
			resolveUpdate(
				"4.0.0-rc.2",
				["4.0.0-rc.2", "4.0.0-rc.3", "4.1.0-alpha.1"],
				"3.9.0",
			),
		).toEqual({
			current: "4.0.0-rc.2",
			target: "4.0.0-rc.3",
			updateType: "prerelease",
		});
	});

	it("respects the latest dist-tag and does not overshoot it", () => {
		expect(
			resolveUpdate("1.0.0", ["1.0.0", "1.1.0", "2.0.0"], "1.1.0"),
		).toEqual({ current: "1.0.0", target: "1.1.0", updateType: "minor" });
	});

	it("can be forced past latest by opting out of respectLatest", () => {
		expect(
			resolveUpdate("1.0.0", ["1.0.0", "1.1.0", "2.0.0"], "1.1.0", {
				respectLatest: false,
			}),
		).toEqual({ current: "1.0.0", target: "2.0.0", updateType: "major" });
	});

	it("can be forced onto a prerelease by opting out of ignoreUnstable", () => {
		expect(
			resolveUpdate("1.2.0", ["1.2.0", "1.3.0-rc.1"], "1.3.0-rc.1", {
				ignoreUnstable: false,
			}),
		).toEqual({
			current: "1.2.0",
			target: "1.3.0-rc.1",
			updateType: "preminor",
		});
	});

	it("returns null for a non-semver current version", () => {
		expect(resolveUpdate("workspace:*", ["1.0.0"], "1.0.0")).toBeNull();
	});
});

describe("fetchOutdated", () => {
	it("maps registry metadata to updates and skips errors and up-to-date deps", async () => {
		getVersionsBatch.mockResolvedValueOnce([
			{
				name: "vitest",
				versions: ["4.1.0", "4.1.7"],
				distTags: { latest: "4.1.7" },
			},
			{
				name: "@octokit/core",
				versions: ["7.0.6"],
				distTags: { latest: "7.0.6" },
			},
			{ name: "ghost", status: 404, error: "Not Found" },
		]);

		const updates = await fetchOutdated([
			{ name: "vitest", version: "4.1.0" },
			{ name: "@octokit/core", version: "7.0.6" },
			{ name: "ghost", version: "1.0.0" },
		]);

		expect(getVersionsBatch).toHaveBeenCalledWith(
			["vitest", "@octokit/core", "ghost"],
			{ throw: false },
		);
		expect(Object.fromEntries(updates)).toEqual({
			vitest: { current: "4.1.0", target: "4.1.7", updateType: "patch" },
		});
	});
});

describe("renderDependencies with updates", () => {
	it("adds Target/Update columns and flags outdated npm deps", () => {
		const markdown = renderDependencies(
			[
				{
					ecosystem: "npm",
					files: [
						{
							file: "package.json",
							dependencies: [
								{ name: "vitest", version: "4.1.0" },
								{ name: "@octokit/core", version: "7.0.6" },
							],
						},
					],
				},
			],
			new Map([
				["vitest", { current: "4.1.0", target: "4.1.7", updateType: "patch" }],
			]),
		);

		expect(markdown).toMatchInlineSnapshot(`
      "## Detected Dependencies

      ### npm (2)

      | Package | Current | Target | Update | Manifest |
      | --- | --- | --- | --- | --- |
      | \`vitest\` | \`4.1.0\` | \`4.1.7\` | patch | \`package.json\` |
      | \`@octokit/core\` | \`7.0.6\` | — | ✅ up to date | \`package.json\` |"
    `);
	});

	it("leaves non-npm ecosystems as plain tables", () => {
		const markdown = renderDependencies(
			[
				{
					ecosystem: "mise",
					files: [
						{
							file: "mise.toml",
							dependencies: [{ name: "node", version: "26.3.0" }],
						},
					],
				},
			],
			new Map(),
		);

		expect(markdown).toContain("| Package | Version | Manifest |");
	});
});
