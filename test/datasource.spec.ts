import { describe, expect, it } from "vitest";
import {
	type Datasource,
	type DependencyRef,
	fetchOutdated,
	type VersionInfo,
} from "../src/datasource.ts";

const NOW = Date.parse("2024-01-10T00:00:00Z");
const AGED = "2024-01-01T00:00:00.000Z"; // 9 days old → safe

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

	it("returns empty without calling lookup when there are no dependencies", async () => {
		const { datasource, calls } = fakeDatasource({});

		const updates = await fetchOutdated([], datasource, { now: NOW });

		expect(updates).toEqual({});
		expect(calls).toEqual([]);
	});
});
