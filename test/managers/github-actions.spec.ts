import type { ContentReader } from "../../src/deps.ts";
import { describe, expect, it, vi } from "vitest";
import {
	githubActionsManager,
	parseWorkflowUses,
} from "../../src/managers/github-actions.ts";

const SHA = "3df4ab11eba7bda6032a0b82a6bb43b11571feac";

describe("parseWorkflowUses", () => {
	it("reads a sha-pinned action with its version comment", () => {
		const content = `jobs:\n  build:\n    steps:\n      - uses: actions/checkout@${SHA} # v4.1.0\n`;
		expect(parseWorkflowUses(content)).toEqual([
			{
				name: "actions/checkout",
				version: SHA,
				depType: "action",
				pinned: true,
				comment: "v4.1.0",
			},
		]);
	});

	it("reads floating and coarse tags, quoted or bare", () => {
		const content = `      - uses: actions/setup-node@v4\n      - uses: "actions/cache@v3.2.1"\n`;
		expect(parseWorkflowUses(content)).toEqual([
			{
				name: "actions/setup-node",
				version: "v4",
				depType: "action",
				pinned: false,
			},
			{
				name: "actions/cache",
				version: "v3.2.1",
				depType: "action",
				pinned: false,
			},
		]);
	});

	it("skips docker, local, and subdir/reusable refs", () => {
		const content = [
			"      - uses: docker://node:20",
			"      - uses: ./.github/actions/local",
			"      - uses: owner/repo/.github/workflows/ci.yml@v1",
			"      - uses: owner/repo/subdir@v2",
		].join("\n");
		expect(parseWorkflowUses(content)).toEqual([]);
	});

	it("keeps the first ref when an action appears more than once", () => {
		const content = `      - uses: actions/checkout@v4\n      - uses: actions/checkout@v3\n`;
		expect(parseWorkflowUses(content)).toEqual([
			{
				name: "actions/checkout",
				version: "v4",
				depType: "action",
				pinned: false,
			},
		]);
	});
});

/** Mock an Octokit that lists a workflow directory and serves file contents. */
function mockReader(
	listing: { path: string; type: string }[],
	files: Record<string, string>,
): ContentReader {
	const getContent = vi.fn(({ path }: { path: string }) => {
		if (path === ".github/workflows") {
			return Promise.resolve({ data: listing });
		}
		const content = files[path];
		if (content === undefined) {
			return Promise.reject(new Error("Not Found"));
		}
		return Promise.resolve({ data: { type: "file", content: btoa(content) } });
	});
	return { rest: { repos: { getContent } } };
}

describe("githubActionsManager.detect", () => {
	it("scans every workflow file and groups actions per file", async () => {
		const octokit = mockReader(
			[
				{ path: ".github/workflows/ci.yml", type: "file" },
				{ path: ".github/workflows/release.yaml", type: "file" },
				{ path: ".github/workflows/notes.txt", type: "file" },
				{ path: ".github/workflows/nested", type: "dir" },
			],
			{
				".github/workflows/ci.yml": `      - uses: actions/checkout@v4\n`,
				".github/workflows/release.yaml": `      - uses: actions/setup-node@${SHA} # v4.1.0\n`,
			},
		);

		const files = await githubActionsManager.detect(octokit, "acme", "repo");

		expect(files).toEqual([
			{
				file: ".github/workflows/ci.yml",
				dependencies: [
					{
						name: "actions/checkout",
						version: "v4",
						depType: "action",
						pinned: false,
					},
				],
			},
			{
				file: ".github/workflows/release.yaml",
				dependencies: [
					{
						name: "actions/setup-node",
						version: SHA,
						depType: "action",
						pinned: true,
						comment: "v4.1.0",
					},
				],
			},
		]);
	});

	it("returns nothing when the workflows directory is missing", async () => {
		const octokit: ContentReader = {
			rest: {
				repos: {
					getContent: vi.fn(() => Promise.reject(new Error("Not Found"))),
				},
			},
		};
		await expect(
			githubActionsManager.detect(octokit, "acme", "repo"),
		).resolves.toEqual([]);
	});
});
