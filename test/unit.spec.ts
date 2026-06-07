import { describe, expect, it, vi } from "vitest";
import {
	type ContentReader,
	listSafeUpgrades,
	parseMiseToml,
	parsePackageJson,
} from "../src/deps.ts";
import { detectDependencies } from "../src/manager.ts";

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
	it("parses supported full tool identifiers with datasource metadata", () => {
		expect(parseMiseToml(MISE_TOML)).toEqual([
			{
				name: "github:endevco/aube",
				datasource: "github-releases",
				lookupName: "endevco/aube",
				version: "1.17.1",
				pinned: true,
			},
			{
				name: "core:node",
				datasource: "core",
				lookupName: "node",
				version: "26.3.0",
				pinned: true,
			},
		]);
	});

	it("keeps shorthand tools as unsupported dependencies", () => {
		const toml = `# comment\n[env]\nFOO = "bar"\n[tools]\nnode = "20.0.0"\n`;
		expect(parseMiseToml(toml)).toEqual([
			{
				name: "node",
				version: "20.0.0",
				pinned: true,
				unsupportedReason:
					"mise shorthand is unsupported; use a full backend identifier",
			},
		]);
	});

	it("extracts the version from an inline table", () => {
		const toml = `[tools]\n"core:node" = { version = "22.1.0", os = ["linux"] }\n`;
		expect(parseMiseToml(toml)).toEqual([
			{
				name: "core:node",
				datasource: "core",
				lookupName: "node",
				version: "22.1.0",
				pinned: true,
			},
		]);
	});

	it("flags a non-exact version as not pinned", () => {
		const toml = `[tools]\n"core:node" = "latest"\n"core:bun" = "1.2"\n`;
		expect(parseMiseToml(toml)).toEqual([
			{
				name: "core:node",
				datasource: "core",
				lookupName: "node",
				version: "latest",
				pinned: false,
			},
			{
				name: "core:bun",
				datasource: "core",
				lookupName: "bun",
				version: "1.2",
				pinned: false,
			},
		]);
	});

	it("keeps decorated full identifiers as unsupported dependencies", () => {
		const toml = `[tools]\n"github:endevco/aube[bin=aube]" = "1.18.0"\n`;
		expect(parseMiseToml(toml)).toEqual([
			{
				name: "github:endevco/aube[bin=aube]",
				version: "1.18.0",
				pinned: true,
				unsupportedReason: "decorated or unsupported mise backend identity",
			},
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
	it("reads both manifests via octokit and groups by manager", async () => {
		const { octokit, getContent } = mockReader({
			"mise.toml": MISE_TOML,
			"package.json": PACKAGE_JSON,
		});

		const managerDependencies = await detectDependencies(
			octokit,
			"craftlions",
			"uppy",
		);

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
		expect(managerDependencies).toEqual([
			{
				manager: "mise",
				files: [
					{
						file: "mise.toml",
						dependencies: [
							{
								name: "github:endevco/aube",
								datasource: "github-releases",
								lookupName: "endevco/aube",
								version: "1.17.1",
								pinned: true,
							},
							{
								name: "core:node",
								datasource: "core",
								lookupName: "node",
								version: "26.3.0",
								pinned: true,
							},
						],
					},
				],
			},
			{
				manager: "npm",
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

		const managerDependencies = await detectDependencies(
			octokit,
			"craftlions",
			"uppy",
		);

		expect(managerDependencies.map((group) => group.manager)).toEqual(["npm"]);
	});
});

describe("listSafeUpgrades", () => {
	it("returns safe upgrades across managers and skips held updates", () => {
		const upgrades = listSafeUpgrades(
			[
				{
					manager: "mise",
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
					manager: "npm",
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
			{
				aube: {
					current: "1.17.1",
					target: "1.18.0",
					updateType: "minor",
					state: "safe",
				},
				node: {
					current: "26.3.0",
					target: null,
					updateType: "minor",
					state: "held",
					heldVersion: "26.4.0",
				},
				vitest: {
					current: "4.1.7",
					target: "4.1.8",
					updateType: "patch",
					state: "safe-newer-held",
					heldVersion: "4.2.0",
				},
			},
		);

		expect(upgrades).toEqual([
			{
				manager: "mise",
				manifest: "mise.toml",
				package: "aube",
				current: "1.17.1",
				target: "1.18.0",
				updateType: "minor",
			},
			{
				manager: "npm",
				manifest: "package.json",
				package: "vitest",
				current: "4.1.7",
				target: "4.1.8",
				updateType: "patch",
			},
		]);
	});

	it("lists safe upgrades from manager-specific update records", () => {
		const upgrades = listSafeUpgrades(
			[
				{
					manager: "mise",
					files: [
						{
							file: "mise.toml",
							dependencies: [{ name: "aube", version: "1.17.1" }],
						},
					],
				},
				{
					manager: "npm",
					files: [
						{
							file: "package.json",
							dependencies: [{ name: "aube", version: "1.0.0" }],
						},
					],
				},
			],
			{
				mise: {
					aube: {
						current: "1.17.1",
						target: "1.18.0",
						updateType: "minor",
						state: "safe",
					},
				},
				npm: {
					aube: {
						current: "1.0.0",
						target: "2.0.0",
						updateType: "major",
						state: "safe",
					},
				},
			},
		);

		expect(upgrades).toEqual([
			{
				manager: "mise",
				manifest: "mise.toml",
				package: "aube",
				current: "1.17.1",
				target: "1.18.0",
				updateType: "minor",
			},
			{
				manager: "npm",
				manifest: "package.json",
				package: "aube",
				current: "1.0.0",
				target: "2.0.0",
				updateType: "major",
			},
		]);
	});
});
