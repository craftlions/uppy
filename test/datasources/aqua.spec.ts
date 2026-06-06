import type { GraphqlClient } from "../../src/datasources/github-tags.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createAquaDatasource,
	fetchOutdatedAqua,
} from "../../src/datasources/aqua.ts";

const AGED = "2024-01-01T00:00:00Z";

vi.mock("fast-npm-meta", () => ({
	getVersionsBatch: vi.fn((names: string[]) =>
		Promise.resolve(
			names.map((name) => ({
				name,
				distTags: { latest: "1.1.0" },
				versionsMeta: {
					"1.0.0": { time: AGED },
					"1.1.0": { time: AGED },
				},
			})),
		),
	),
}));

function stubFetch(files: Record<string, string>) {
	vi.stubGlobal(
		"fetch",
		vi.fn((input: string) => {
			const path = new URL(input).pathname;
			const key = path.replace(/^\/aquaproj\/aqua-registry\/main\/pkgs\//, "");
			const body = files[key];
			return Promise.resolve(
				body === undefined
					? new Response("Not Found", { status: 404 })
					: new Response(body, { status: 200 }),
			);
		}),
	);
}

function fakeClient(): GraphqlClient {
	return {
		graphql: (_query, variables) => {
			const repo = `${variables?.owner}/${variables?.name}`;
			if (repo === "jdx/usage") {
				return Promise.resolve({
					repository: {
						releases: {
							nodes: [{ tagName: "v2.0.0", publishedAt: AGED, isDraft: false }],
						},
					},
				});
			}
			if (repo === "openai/codex") {
				return Promise.resolve({
					repository: {
						releases: {
							nodes: [
								{
									tagName: "rust-0.64.0",
									publishedAt: AGED,
									isDraft: false,
								},
							],
						},
					},
				});
			}
			if (repo === "example/tags") {
				return Promise.resolve({
					repository: {
						refs: {
							nodes: [
								{
									name: "v1.1.0",
									target: {
										__typename: "Commit",
										oid: "a".repeat(40),
										committedDate: AGED,
									},
								},
							],
						},
						releases: { nodes: [] },
					},
				});
			}
			return Promise.resolve({ repository: null });
		},
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("createAquaDatasource", () => {
	it("routes github_release registry packages through GitHub releases", async () => {
		stubFetch({
			"jdx/usage/registry.yaml": `packages:
  - type: github_release
    repo_owner: jdx
    repo_name: usage
`,
		});

		const found = await createAquaDatasource(fakeClient()).lookup([
			{ name: "jdx/usage", ref: "1.0.0", key: "aqua:jdx/usage" },
		]);

		expect(found.get("aqua:jdx/usage")).toEqual({
			versions: ["v2.0.0"],
			times: { "v2.0.0": AGED },
			latest: "v2.0.0",
		});
	});

	it("strips aqua version_prefix values from release tags", async () => {
		stubFetch({
			"openai/codex/registry.yaml": `packages:
  - type: github_release
    repo_owner: openai
    repo_name: codex
    version_prefix: rust-
`,
		});

		const found = await createAquaDatasource(fakeClient()).lookup([
			{ name: "openai/codex", ref: "0.63.0", key: "aqua:openai/codex" },
		]);

		expect(found.get("aqua:openai/codex")).toEqual({
			versions: ["0.64.0"],
			times: { "0.64.0": AGED },
			latest: "0.64.0",
		});
	});

	it("routes github_tag registry packages through GitHub tags", async () => {
		stubFetch({
			"example/tags/registry.yaml": `packages:
  - type: http
    repo_owner: example
    repo_name: tags
    version_source: github_tag
`,
		});

		const found = await createAquaDatasource(fakeClient()).lookup([
			{ name: "example/tags", ref: "v1.0.0", key: "aqua:example/tags" },
		]);

		expect(found.get("aqua:example/tags")).toMatchObject({
			versions: ["v1.1.0"],
			times: { "v1.1.0": AGED },
		});
	});

	it("does not surface digest-only updates for github_tag registry packages", async () => {
		stubFetch({
			"example/tags/registry.yaml": `packages:
  - type: http
    repo_owner: example
    repo_name: tags
    version_source: github_tag
`,
		});

		const updates = await fetchOutdatedAqua(
			[
				{
					name: "aqua:example/tags",
					lookupName: "example/tags",
					version: "v1.1.0",
				},
			],
			fakeClient(),
		);

		expect(updates).toEqual({});
	});

	it("routes aqua-renovate-config npm exceptions through npm", async () => {
		stubFetch({});

		const found = await createAquaDatasource(fakeClient()).lookup([
			{
				name: "trunk-io/launcher",
				ref: "1.0.0",
				key: "aqua:trunk-io/launcher",
			},
		]);

		expect(found.get("aqua:trunk-io/launcher")).toEqual({
			versions: ["1.0.0", "1.1.0"],
			times: { "1.0.0": AGED, "1.1.0": AGED },
			latest: "1.1.0",
		});
	});
});
