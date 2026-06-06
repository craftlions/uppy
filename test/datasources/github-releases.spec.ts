import type { GraphqlClient } from "../../src/datasources/github-tags.ts";
import { describe, expect, it } from "vitest";
import {
	createGithubReleasesDatasource,
	fetchOutdatedGithubReleases,
} from "../../src/datasources/github-releases.ts";

const NOW = Date.parse("2024-01-10T00:00:00Z");
const AGED = "2024-01-01T00:00:00Z";
const FRESH = "2024-01-09T00:00:00Z";

function fakeClient(releases: Record<string, unknown[]>): GraphqlClient {
	return {
		graphql: (_query, variables) => {
			const key = `${variables?.owner}/${variables?.name}`;
			return Promise.resolve({
				repository:
					key in releases ? { releases: { nodes: releases[key] } } : null,
			});
		},
	};
}

describe("createGithubReleasesDatasource", () => {
	it("reads release tags and publish times", async () => {
		const datasource = createGithubReleasesDatasource(
			fakeClient({
				"endevco/aube": [
					{ tagName: "v1.1.0", publishedAt: AGED, isDraft: false },
					{ tagName: "v1.2.0", publishedAt: FRESH, isDraft: false },
					{ tagName: "nightly", publishedAt: FRESH, isDraft: false },
					{ tagName: "v9.0.0", publishedAt: FRESH, isDraft: true },
				],
			}),
		);

		const found = await datasource.lookup([
			{ name: "endevco/aube", ref: "1.0.0", key: "github:endevco/aube" },
		]);

		expect(found.get("github:endevco/aube")).toEqual({
			versions: ["v1.1.0", "v1.2.0", "nightly"],
			times: { "v1.1.0": AGED, "v1.2.0": FRESH, nightly: FRESH },
			latest: "v1.2.0",
		});
	});
});

describe("fetchOutdatedGithubReleases", () => {
	it("classifies release updates by minimum release age", async () => {
		const updates = await fetchOutdatedGithubReleases(
			[
				{
					name: "github:endevco/aube",
					lookupName: "endevco/aube",
					version: "1.0.0",
				},
			],
			fakeClient({
				"endevco/aube": [
					{ tagName: "v1.1.0", publishedAt: AGED, isDraft: false },
					{ tagName: "v1.2.0", publishedAt: FRESH, isDraft: false },
				],
			}),
			{ now: NOW },
		);

		expect(updates).toEqual({
			"github:endevco/aube": {
				current: "1.0.0",
				target: "v1.1.0",
				updateType: "minor",
				state: "safe-newer-held",
				heldVersion: "v1.2.0",
			},
		});
	});
});
