import { describe, expect, it, vi } from "vitest";
import {
	type ContentReader,
	detectDependencies,
	listSafeUpgrades,
	parseMiseToml,
	parsePackageJson,
	renderDependencies,
} from "../src/deps.ts";

const MISE_TOML = `[tools]
"github:endevco/aube" = "1.17.1"
"core:node" = "26.3.0"
`;

const PACKAGE_JSON = JSON.stringify({
	dependencies: { "@octokit/core": "7.0.6" },
	devDependencies: { vitest: "^4.1.7" },
});

/** Build a mocked Octokit whose getContent serves base64 file fixtures. */
function mockReader(files: Record<string, string>): {
	octokit: ContentReader;
	getContent: ReturnType<typeof vi.fn>;
} {
	const getContent = vi.fn(
		({ path }: { owner: string; repo: string; path: string }) => {
			const content = files[path];
			if (content === undefined) {
				return Promise.reject(new Error("Not Found"));
			}
			return Promise.resolve({
				data: { type: "file", content: btoa(content) },
			});
		},
	);
	return { octokit: { rest: { repos: { getContent } } }, getContent };
}

describe("parseMiseToml", () => {
	it("parses tools and normalizes names", () => {
		expect(parseMiseToml(MISE_TOML)).toEqual([
			{ name: "aube", version: "1.17.1", pinned: true },
			{ name: "node", version: "26.3.0", pinned: true },
		]);
	});

	it("ignores non-tool tables and comments", () => {
		const toml = `# comment\n[env]\nFOO = "bar"\n[tools]\nnode = "20.0.0"\n`;
		expect(parseMiseToml(toml)).toEqual([
			{ name: "node", version: "20.0.0", pinned: true },
		]);
	});

	it("extracts the version from an inline table", () => {
		const toml = `[tools]\nnode = { version = "22.1.0", os = ["linux"] }\n`;
		expect(parseMiseToml(toml)).toEqual([
			{ name: "node", version: "22.1.0", pinned: true },
		]);
	});

	it("flags a non-exact version as not pinned", () => {
		const toml = `[tools]\nnode = "latest"\nbun = "1.2"\n`;
		expect(parseMiseToml(toml)).toEqual([
			{ name: "node", version: "latest", pinned: false },
			{ name: "bun", version: "1.2", pinned: false },
		]);
	});
});

describe("parsePackageJson", () => {
	it("merges dependencies and devDependencies, strips ranges and records pin state", () => {
		expect(parsePackageJson(PACKAGE_JSON)).toEqual([
			{
				name: "@octokit/core",
				version: "7.0.6",
				pinned: true,
				depType: "dependencies",
			},
			{
				name: "vitest",
				version: "4.1.7",
				pinned: false,
				depType: "devDependencies",
			},
		]);
	});

	it("returns an empty list when there are no dependencies", () => {
		expect(parsePackageJson("{}")).toEqual([]);
	});
});

describe("detectDependencies", () => {
	it("reads both manifests via octokit and groups by ecosystem", async () => {
		const { octokit, getContent } = mockReader({
			"mise.toml": MISE_TOML,
			"package.json": PACKAGE_JSON,
		});

		const ecosystems = await detectDependencies(octokit, "craftlions", "uppy");

		expect(getContent).toHaveBeenCalledWith({
			owner: "craftlions",
			repo: "uppy",
			path: "mise.toml",
		});
		expect(getContent).toHaveBeenCalledWith({
			owner: "craftlions",
			repo: "uppy",
			path: "package.json",
		});
		expect(ecosystems).toEqual([
			{
				ecosystem: "mise",
				files: [
					{
						file: "mise.toml",
						dependencies: [
							{ name: "aube", version: "1.17.1", pinned: true },
							{ name: "node", version: "26.3.0", pinned: true },
						],
					},
				],
			},
			{
				ecosystem: "npm",
				files: [
					{
						file: "package.json",
						dependencies: [
							{
								name: "@octokit/core",
								version: "7.0.6",
								pinned: true,
								depType: "dependencies",
							},
							{
								name: "vitest",
								version: "4.1.7",
								pinned: false,
								depType: "devDependencies",
							},
						],
					},
				],
			},
		]);
	});

	it("skips manifests that are missing", async () => {
		const { octokit } = mockReader({ "package.json": PACKAGE_JSON });

		const ecosystems = await detectDependencies(octokit, "craftlions", "uppy");

		expect(ecosystems.map((eco) => eco.ecosystem)).toEqual(["npm"]);
	});
});

describe("renderDependencies", () => {
	it("renders a markdown table per ecosystem", () => {
		const markdown = renderDependencies([
			{
				ecosystem: "mise",
				files: [
					{
						file: "mise.toml",
						dependencies: [{ name: "aube", version: "1.17.1" }],
					},
				],
			},
			{
				ecosystem: "npm",
				files: [
					{
						file: "package.json",
						dependencies: [{ name: "@octokit/core", version: "7.0.6" }],
					},
				],
			},
		]);

		expect(markdown).toMatchInlineSnapshot(`
      "## Detected Dependencies

      ### mise (1)

      | Package | Version | Manifest |
      | --- | --- | --- |
      | \`aube\` | \`1.17.1\` | \`mise.toml\` |

      ### npm (1)

      | Package | Version | Manifest |
      | --- | --- | --- |
      | \`@octokit/core\` | \`7.0.6\` | \`package.json\` |"
    `);
	});

	it("returns an empty string when nothing is detected", () => {
		expect(renderDependencies([])).toBe("");
	});

	it("flags unpinned dependencies with a pin action", () => {
		const markdown = renderDependencies(
			[
				{
					ecosystem: "npm",
					files: [
						{
							file: "package.json",
							dependencies: [
								{
									name: "@octokit/core",
									version: "7.0.6",
									pinned: true,
									depType: "dependencies",
								},
								{
									name: "vitest",
									version: "4.1.7",
									pinned: false,
									depType: "devDependencies",
								},
							],
						},
					],
				},
			],
			new Map(),
			new Set(["vitest"]),
		);

		expect(markdown).toMatchInlineSnapshot(`
      "## Detected Dependencies

      ### npm (2)

      | Package | Current | Target | Update | Manifest |
      | --- | --- | --- | --- | --- |
      | \`@octokit/core\` | \`7.0.6\` | — | ✅ up to date | \`package.json\` |
      | \`vitest\` | \`4.1.7\` | — | 📌 pin | \`package.json\` |"
    `);
	});

	it("appends the pin action to a pending update", () => {
		const markdown = renderDependencies(
			[
				{
					ecosystem: "npm",
					files: [
						{
							file: "package.json",
							dependencies: [
								{
									name: "vitest",
									version: "4.1.7",
									pinned: false,
									depType: "devDependencies",
								},
							],
						},
					],
				},
			],
			new Map([
				[
					"vitest",
					{
						current: "4.1.7",
						target: "4.2.0",
						updateType: "minor",
						state: "safe",
					},
				],
			]),
			new Set(["vitest"]),
		);

		expect(markdown).toContain("🟢 minor (safe) 📌 pin");
	});
});

describe("listSafeUpgrades", () => {
	it("returns safe upgrades across ecosystems and skips held updates", () => {
		const upgrades = listSafeUpgrades(
			[
				{
					ecosystem: "mise",
					files: [
						{
							file: "mise.toml",
							dependencies: [
								{ name: "aube", version: "1.17.1" },
								{ name: "node", version: "26.3.0" },
							],
						},
					],
				},
				{
					ecosystem: "npm",
					files: [
						{
							file: "package.json",
							dependencies: [
								{ name: "@octokit/core", version: "7.0.6" },
								{ name: "vitest", version: "4.1.7" },
							],
						},
					],
				},
			],
			new Map([
				[
					"aube",
					{
						current: "1.17.1",
						target: "1.18.0",
						updateType: "minor",
						state: "safe",
					},
				],
				[
					"node",
					{
						current: "26.3.0",
						target: null,
						updateType: "minor",
						state: "held",
						heldVersion: "26.4.0",
					},
				],
				[
					"vitest",
					{
						current: "4.1.7",
						target: "4.1.8",
						updateType: "patch",
						state: "safe-newer-held",
						heldVersion: "4.2.0",
					},
				],
			]),
		);

		expect(upgrades).toEqual([
			{
				ecosystem: "mise",
				manifest: "mise.toml",
				package: "aube",
				current: "1.17.1",
				target: "1.18.0",
				updateType: "minor",
			},
			{
				ecosystem: "npm",
				manifest: "package.json",
				package: "vitest",
				current: "4.1.7",
				target: "4.1.8",
				updateType: "patch",
			},
		]);
	});
});
