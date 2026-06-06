import { describe, expect, it } from "vitest";
import {
	createGithubTagsDatasource,
	fetchOutdatedGithubActions,
	type GraphqlClient,
} from "../../src/datasources/github-tags.ts";

const NOW = Date.parse("2024-01-10T00:00:00Z");
const AGED = "2024-01-01T00:00:00.000Z"; // 9 days old → safe
const FRESH = "2024-01-09T00:00:00.000Z"; // 1 day old → too fresh

const sha = (char: string): string => char.repeat(40);
const A = sha("a"); // v4.2.0 + the moving v4 tag
const B = sha("b"); // v4.1.0
const C = sha("c"); // v3.6.0
const D = sha("d"); // v5.0.0

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

describe("fetchOutdatedGithubActions", () => {
	const client = fakeClient({ "actions/checkout": CHECKOUT });

	it("pins a floating tag and bumps it to the safest aged version", async () => {
		const updates = await fetchOutdatedGithubActions(
			[{ name: "actions/checkout", version: "v4.1.0", depType: "action" }],
			client,
			{ now: NOW },
		);
		expect(updates["actions/checkout@v4.1.0"]).toEqual({
			current: "v4.1.0",
			target: "v4.2.0",
			updateType: "minor",
			state: "safe",
			currentDigest: undefined,
			targetDigest: A,
		});
	});

	it("moves a stale pin to the newest aged version", async () => {
		const updates = await fetchOutdatedGithubActions(
			[
				{
					name: "actions/checkout",
					version: B,
					depType: "action",
					pinned: true,
				},
			],
			client,
			{ now: NOW },
		);
		expect(updates[`actions/checkout@${B}`]).toEqual({
			current: "v4.1.0",
			target: "v4.2.0",
			updateType: "minor",
			state: "safe",
			currentDigest: B,
			targetDigest: A,
		});
	});

	it("omits an action already pinned to the newest version", async () => {
		const updates = await fetchOutdatedGithubActions(
			[
				{
					name: "actions/checkout",
					version: A,
					depType: "action",
					pinned: true,
				},
			],
			client,
			{ now: NOW },
		);
		expect(updates[`actions/checkout@${A}`]).toBeUndefined();
	});

	it("digest-pins a coarse tag that has no higher track", async () => {
		const updates = await fetchOutdatedGithubActions(
			[{ name: "actions/checkout", version: "v4", depType: "action" }],
			client,
			{ now: NOW },
		);
		expect(updates["actions/checkout@v4"]).toEqual({
			current: "v4",
			target: "v4",
			updateType: "digest",
			state: "safe",
			currentDigest: undefined,
			targetDigest: A,
		});
	});

	it("resolves each occurrence of an action independently across refs", async () => {
		const updates = await fetchOutdatedGithubActions(
			[
				{ name: "actions/checkout", version: "v3.6.0", depType: "action" },
				{ name: "actions/checkout", version: "v4.1.0", depType: "action" },
			],
			client,
			{ now: NOW },
		);
		// The v3 occurrence bumps across a major; the v4.1.0 occurrence bumps a
		// minor — neither inherits the other's current/target/digest.
		expect(updates["actions/checkout@v3.6.0"]).toMatchObject({
			current: "v3.6.0",
			target: "v4.2.0",
			updateType: "major",
			targetDigest: A,
		});
		expect(updates["actions/checkout@v4.1.0"]).toMatchObject({
			current: "v4.1.0",
			target: "v4.2.0",
			updateType: "minor",
			targetDigest: A,
		});
	});

	it("upgrades a coarse track in a repo that publishes only coarse tags", async () => {
		const coarseOnly = fakeClient({
			"acme/action": repo([
				{ name: "v5", oid: D, date: AGED },
				{ name: "v4", oid: A, date: AGED },
			]),
		});
		const updates = await fetchOutdatedGithubActions(
			[{ name: "acme/action", version: "v4", depType: "action" }],
			coarseOnly,
			{ now: NOW },
		);
		expect(updates["acme/action@v4"]).toMatchObject({
			current: "v4",
			target: "v5",
			updateType: "major",
			targetDigest: D,
		});
	});

	it("offers a coarse tag the next major track when one exists", async () => {
		const withV5 = fakeClient({
			"actions/checkout": repo(
				[
					{ name: "v5.0.0", oid: D, date: AGED },
					{ name: "v4.2.0", oid: A, date: AGED },
					{ name: "v4", oid: A, date: AGED },
				],
				["v5.0.0", "v4.2.0"],
			),
		});
		const updates = await fetchOutdatedGithubActions(
			[{ name: "actions/checkout", version: "v4", depType: "action" }],
			withV5,
			{ now: NOW },
		);
		expect(updates["actions/checkout@v4"]).toEqual({
			current: "v4",
			target: "v5.0.0",
			updateType: "major",
			state: "safe",
			currentDigest: undefined,
			targetDigest: D,
		});
	});

	it("pins to the current version's sha while holding back a too-fresh newer tag", async () => {
		const fresh = fakeClient({
			"actions/checkout": repo(
				[
					{ name: "v4.2.0", oid: A, date: FRESH },
					{ name: "v4.1.0", oid: B, date: AGED },
				],
				// v4.2.0 cut no release, so its age falls back to the fresh commit date.
				["v4.1.0"],
			),
		});
		const updates = await fetchOutdatedGithubActions(
			[{ name: "actions/checkout", version: "v4.1.0", depType: "action" }],
			fresh,
			{ now: NOW },
		);
		expect(updates["actions/checkout@v4.1.0"]).toEqual({
			current: "v4.1.0",
			target: null,
			updateType: "minor",
			state: "held",
			heldVersion: "v4.2.0",
			currentDigest: undefined,
			targetDigest: B,
		});
	});
});
