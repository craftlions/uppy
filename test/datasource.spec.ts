import { describe, expect, it } from "vitest";
import {
	type Datasource,
	type DependencyRef,
	fetchOutdated,
	type VersionInfo,
} from "../src/datasource.ts";

const NOW = Date.parse("2024-01-10T00:00:00Z");
const AGED = "2024-01-01T00:00:00.000Z"; // 9 days old → safe
const FRESH = "2024-01-09T00:00:00.000Z"; // 1 day old → too fresh

/**
 * An in-memory {@link Datasource} serving canned {@link VersionInfo} per name and
 * recording the name lists it was asked to look up. Lets the resolver be tested
 * without any npm or mise round-trip.
 */
function fakeDatasource(table: Record<string, VersionInfo>): {
	datasource: Datasource;
	calls: DependencyRef[][];
} {
	const calls: DependencyRef[][] = [];
	const datasource: Datasource = {
		lookup(refs) {
			calls.push(refs);
			const found = new Map<string, VersionInfo>();
			for (const { name, key } of refs) {
				const info = table[name];
				if (info) {
					found.set(key ?? name, info);
				}
			}
			return Promise.resolve(found);
		},
	};
	return { datasource, calls };
}

describe("fetchOutdated", () => {
	it("dedupes names (first version wins) and classifies through the datasource", async () => {
		const { datasource, calls } = fakeDatasource({
			pkg: {
				versions: ["1.0.0", "1.1.0"],
				times: { "1.0.0": AGED, "1.1.0": AGED },
				latest: "1.1.0",
			},
		});

		const updates = await fetchOutdated(
			[
				{ name: "pkg", version: "1.0.0" },
				{ name: "pkg", version: "9.9.9" },
			],
			datasource,
			{ now: NOW },
		);

		expect(calls).toEqual([[{ name: "pkg", ref: "1.0.0", key: "pkg" }]]);
		expect(updates).toEqual({
			pkg: {
				current: "1.0.0",
				target: "1.1.0",
				updateType: "minor",
				state: "safe",
			},
		});
	});

	it("looks up datasource names while keying updates by display names", async () => {
		const { datasource, calls } = fakeDatasource({
			node: {
				versions: ["1.0.0", "1.1.0"],
				times: { "1.1.0": AGED },
				latest: "1.1.0",
			},
		});

		const updates = await fetchOutdated(
			[
				{
					name: "core:node",
					lookupName: "node",
					version: "1.0.0",
				},
			],
			datasource,
			{ now: NOW },
		);

		expect(calls).toEqual([[{ name: "node", ref: "1.0.0", key: "core:node" }]]);
		expect(updates).toEqual({
			"core:node": {
				current: "1.0.0",
				target: "1.1.0",
				updateType: "minor",
				state: "safe",
			},
		});
	});

	it("omits dependencies with no newer acceptable version", async () => {
		const { datasource } = fakeDatasource({
			pkg: { versions: ["1.0.0"], times: { "1.0.0": AGED }, latest: "1.0.0" },
		});

		const updates = await fetchOutdated(
			[{ name: "pkg", version: "1.0.0" }],
			datasource,
			{ now: NOW },
		);

		expect(updates).toEqual({});
	});

	it("skips names the datasource does not return", async () => {
		const { datasource } = fakeDatasource({});

		const updates = await fetchOutdated(
			[{ name: "ghost", version: "1.0.0" }],
			datasource,
			{ now: NOW },
		);

		expect(updates).toEqual({});
	});

	it("skips entries the datasource returns with no versions", async () => {
		const { datasource } = fakeDatasource({
			pkg: { versions: [], times: {}, latest: "" },
		});

		const updates = await fetchOutdated(
			[{ name: "pkg", version: "1.0.0" }],
			datasource,
			{ now: NOW },
		);

		expect(updates).toEqual({});
	});

	describe("digest composition (composeDigestStatus)", () => {
		const SHA_A = "a".repeat(40);
		const SHA_B = "b".repeat(40);

		it("attaches digest fields when a version update exists", async () => {
			const { datasource } = fakeDatasource({
				action: {
					versions: ["v4.1.0", "v4.2.0"],
					times: { "v4.1.0": AGED, "v4.2.0": AGED },
					latest: "v4.2.0",
					currentDigest: SHA_B,
					digests: { "v4.1.0": SHA_B, "v4.2.0": SHA_A },
				},
			});

			const updates = await fetchOutdated(
				[{ name: "action", version: "v4.1.0" }],
				datasource,
				{ now: NOW },
			);

			expect(updates["action"]).toEqual({
				current: "v4.1.0",
				target: "v4.2.0",
				updateType: "minor",
				state: "safe",
				currentDigest: SHA_B,
				targetDigest: SHA_A,
			});
		});

		it("creates a digest-only update when a floating tag has no version bump", async () => {
			const { datasource } = fakeDatasource({
				action: {
					versions: ["v4"],
					times: { v4: AGED },
					latest: "v4",
					digests: { v4: SHA_A },
				},
			});

			const updates = await fetchOutdated(
				[{ name: "action", version: "v4" }],
				datasource,
				{ now: NOW },
			);

			expect(updates["action"]).toEqual({
				current: "v4",
				target: "v4",
				updateType: "digest",
				state: "safe",
				targetDigest: SHA_A,
			});
		});

		it("omits an already-pinned dependency when the digest is current", async () => {
			const { datasource } = fakeDatasource({
				action: {
					versions: ["v4.2.0"],
					times: { "v4.2.0": AGED },
					latest: "v4.2.0",
					currentVersion: "v4.2.0",
					currentDigest: SHA_A,
					digests: { "v4.2.0": SHA_A },
				},
			});

			const updates = await fetchOutdated(
				[{ name: "action", version: SHA_A }],
				datasource,
				{ now: NOW },
			);

			expect(updates).toEqual({});
		});

		it("attaches digest fields to a held update", async () => {
			const { datasource } = fakeDatasource({
				action: {
					versions: ["v4.1.0", "v4.2.0"],
					times: { "v4.1.0": AGED, "v4.2.0": FRESH },
					latest: "v4.2.0",
					currentDigest: SHA_B,
					digests: { "v4.1.0": SHA_B, "v4.2.0": SHA_A },
				},
			});

			const updates = await fetchOutdated(
				[{ name: "action", version: "v4.1.0" }],
				datasource,
				{ now: NOW },
			);

			expect(updates["action"]).toEqual({
				current: "v4.1.0",
				target: null,
				updateType: "minor",
				state: "held",
				heldVersion: "v4.2.0",
				currentDigest: SHA_B,
				targetDigest: SHA_B,
			});
		});
	});

	it("returns empty without calling lookup when there are no dependencies", async () => {
		const { datasource, calls } = fakeDatasource({});

		const updates = await fetchOutdated([], datasource, { now: NOW });

		expect(updates).toEqual({});
		expect(calls).toEqual([]);
	});
});
