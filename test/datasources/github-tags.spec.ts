import { describe, expect, it } from "vitest";
import {
	createGithubTagsDatasource,
	type GraphqlClient,
} from "../../src/datasources/github-tags.ts";

const AGED = "2024-01-01T00:00:00.000Z"; // 9 days old → safe

const sha = (char: string): string => char.repeat(40);
const A = sha("a"); // v4.2.0 + the moving v4 tag
const B = sha("b"); // v4.1.0
const C = sha("c"); // v3.6.0

interface TagSpec {
	name: string;
	oid: string;
	date: string;
	annotated?: boolean;
}

/** Build a refs/releases response for one repo from a flat list of tags. */
function repo(tags: TagSpec[], releases: string[] = []) {
	return {
		refs: {
			nodes: tags.map(({ name, oid, date, annotated }) => ({
				name,
				target: annotated
					? {
							__typename: "Tag",
							target: { __typename: "Commit", oid, committedDate: date },
						}
					: { __typename: "Commit", oid, committedDate: date },
			})),
		},
		releases: {
			nodes: releases.map((tagName) => ({
				tagName,
				publishedAt: AGED,
			})),
		},
	};
}

/** A GraphQL client serving canned repository data keyed by `owner/name`. */
function fakeClient(repos: Record<string, unknown>): GraphqlClient {
	return {
		graphql<T>(_query: string, variables?: Record<string, unknown>) {
			const key = `${variables?.owner}/${variables?.name}`;
			return Promise.resolve({ repository: repos[key] ?? null } as T);
		},
	};
}

const CHECKOUT = repo(
	[
		{ name: "v4.2.0", oid: A, date: AGED },
		{ name: "v4", oid: A, date: AGED },
		{ name: "v4.1.0", oid: B, date: AGED },
		{ name: "v3.6.0", oid: C, date: AGED },
	],
	["v4.2.0", "v4.1.0", "v3.6.0"],
);

describe("createGithubTagsDatasource.lookup", () => {
	it("resolves a pinned sha to its most specific tag and maps version digests", async () => {
		const datasource = createGithubTagsDatasource(
			fakeClient({ "actions/checkout": CHECKOUT }),
		);

		const found = await datasource.lookup([
			{ name: "actions/checkout", ref: A },
		]);
		const info = found.get("actions/checkout");

		// The sha A is shared by v4.2.0 and the moving v4 tag; the concrete one wins.
		expect(info?.currentVersion).toBe("v4.2.0");
		expect(info?.currentDigest).toBe(A);
		// Coarse tracks (`v4`) are candidate versions too, so a repo that only
		// publishes moving tags still surfaces upgrades.
		expect(info?.versions).toEqual(["v4.2.0", "v4", "v4.1.0", "v3.6.0"]);
		expect(info?.latest).toBe("v4.2.0");
		expect(info?.digests).toEqual({
			"v4.2.0": A,
			v4: A,
			"v4.1.0": B,
			"v3.6.0": C,
		});
	});

	it("peels an annotated tag to its target commit", async () => {
		const datasource = createGithubTagsDatasource(
			fakeClient({
				"acme/action": repo([
					{ name: "v1.0.0", oid: B, date: AGED, annotated: true },
				]),
			}),
		);

		const found = await datasource.lookup([{ name: "acme/action", ref: B }]);
		expect(found.get("acme/action")?.currentDigest).toBe(B);
		expect(found.get("acme/action")?.currentVersion).toBe("v1.0.0");
	});

	it("skips a repository the client cannot resolve", async () => {
		const datasource = createGithubTagsDatasource(fakeClient({}));
		const found = await datasource.lookup([{ name: "ghost/repo", ref: "v1" }]);
		expect(found.has("ghost/repo")).toBe(false);
	});
});
