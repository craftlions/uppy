import { describe, expect, it, vi } from "vitest";
import { datasourceNpm, fetchOutdatedNpm } from "../../src/datasources/npm.ts";

const getVersionsBatch = vi.hoisted(() => vi.fn());
vi.mock("fast-npm-meta", () => ({ getVersionsBatch }));

const NOW = Date.parse("2024-01-10T00:00:00Z");
const AGED = "2024-01-01T00:00:00.000Z"; // 9 days old → safe
const FRESH = "2024-01-09T00:00:00.000Z"; // 1 day old → too fresh

describe("datasourceNpm.lookup", () => {
	it("chunks names into batches of 50 and maps registry metadata to VersionInfo", async () => {
		const names = Array.from({ length: 51 }, (_, i) => `pkg-${i}`);
		getVersionsBatch
			.mockResolvedValueOnce([
				{
					name: "pkg-0",
					versionsMeta: { "1.0.0": { time: AGED }, "1.1.0": { time: FRESH } },
					distTags: { latest: "1.1.0" },
				},
			])
			.mockResolvedValueOnce([
				{
					name: "pkg-50",
					versionsMeta: { "2.0.0": { time: AGED } },
					distTags: { latest: "2.0.0" },
				},
			]);

		const found = await datasourceNpm.lookup(
			names.map((name) => ({ name, ref: "1.0.0" })),
		);

		expect(getVersionsBatch).toHaveBeenCalledTimes(2);
		expect(getVersionsBatch.mock.calls[0][0]).toHaveLength(50);
		expect(getVersionsBatch.mock.calls[1][0]).toEqual(["pkg-50"]);
		expect(found.get("pkg-0")).toEqual({
			versions: ["1.0.0", "1.1.0"],
			times: { "1.0.0": AGED, "1.1.0": FRESH },
			latest: "1.1.0",
		});
		expect(found.get("pkg-50")).toEqual({
			versions: ["2.0.0"],
			times: { "2.0.0": AGED },
			latest: "2.0.0",
		});
	});

	it("omits entries without a latest dist-tag", async () => {
		getVersionsBatch.mockResolvedValueOnce([
			{ name: "ghost", status: 404, error: "Not Found" },
		]);

		const found = await datasourceNpm.lookup([{ name: "ghost", ref: "1.0.0" }]);

		expect(found.has("ghost")).toBe(false);
	});
});

describe("fetchOutdatedNpm", () => {
	it("requests publish metadata, skips errors, and classifies each update by age", async () => {
		getVersionsBatch.mockResolvedValueOnce([
			{
				name: "safe-pkg",
				versionsMeta: { "1.0.0": { time: AGED }, "1.1.0": { time: AGED } },
				distTags: { latest: "1.1.0" },
			},
			{
				name: "newer-held-pkg",
				versionsMeta: {
					"1.0.0": { time: AGED },
					"1.1.0": { time: AGED },
					"1.2.0": { time: FRESH },
				},
				distTags: { latest: "1.2.0" },
			},
			{
				name: "held-pkg",
				versionsMeta: { "1.0.0": { time: AGED }, "1.1.0": { time: FRESH } },
				distTags: { latest: "1.1.0" },
			},
			{
				name: "current-pkg",
				versionsMeta: { "2.0.0": { time: AGED } },
				distTags: { latest: "2.0.0" },
			},
			{ name: "ghost", status: 404, error: "Not Found" },
		]);

		const updates = await fetchOutdatedNpm(
			[
				{ name: "safe-pkg", version: "1.0.0" },
				{ name: "newer-held-pkg", version: "1.0.0" },
				{ name: "held-pkg", version: "1.0.0" },
				{ name: "current-pkg", version: "2.0.0" },
				{ name: "ghost", version: "1.0.0" },
			],
			{ now: NOW },
		);

		expect(getVersionsBatch).toHaveBeenCalledWith(
			["safe-pkg", "newer-held-pkg", "held-pkg", "current-pkg", "ghost"],
			{ metadata: true },
		);
		expect(updates).toEqual({
			"safe-pkg": {
				current: "1.0.0",
				target: "1.1.0",
				updateType: "minor",
				state: "safe",
			},
			"newer-held-pkg": {
				current: "1.0.0",
				target: "1.1.0",
				updateType: "minor",
				state: "safe-newer-held",
				heldVersion: "1.2.0",
			},
			"held-pkg": {
				current: "1.0.0",
				target: null,
				updateType: "minor",
				state: "held",
				heldVersion: "1.1.0",
			},
		});
	});
});
