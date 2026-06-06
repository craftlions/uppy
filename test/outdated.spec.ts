import { describe, expect, it, vi } from "vitest";
import {
	effectiveMinimumReleaseAge,
	fetchOutdated,
	resolveUpdate,
	resolveUpdateStatus,
	THREE_DAYS_MS,
} from "../src/outdated.ts";

const getVersionsBatch = vi.hoisted(() => vi.fn());
vi.mock("fast-npm-meta", () => ({ getVersionsBatch }));

const NOW = Date.parse("2024-01-10T00:00:00Z");
const AGED = "2024-01-01T00:00:00Z"; // 9 days old → safe
const FRESH = "2024-01-09T00:00:00Z"; // 1 day old → too fresh

describe("resolveUpdate", () => {
	it("bumps a stable version to the newest stable release", () => {
		expect(
			resolveUpdate("1.2.0", ["1.2.0", "1.2.1", "1.3.0"], "1.3.0"),
		).toEqual({ current: "1.2.0", target: "1.3.0", updateType: "minor" });
	});

	it("returns null when already on the latest stable", () => {
		expect(resolveUpdate("1.3.0", ["1.2.0", "1.3.0"], "1.3.0")).toBeNull();
	});

	it("ignores prerelease releases for a stable current version", () => {
		expect(resolveUpdate("1.2.0", ["1.2.0", "1.3.0-rc.1"], "1.2.0")).toBeNull();
	});

	it("does not jump unstable tracks: rc current goes to the stable release only", () => {
		// Renovate's documented example: on 4.0.0-rc.2 with 4.0.0 and
		// 4.1.0-alpha.1 available, the update is to 4.0.0 only.
		expect(
			resolveUpdate(
				"4.0.0-rc.2",
				["4.0.0-rc.2", "4.0.0-rc.3", "4.0.0", "4.1.0-alpha.1"],
				"4.0.0",
			),
		).toEqual({ current: "4.0.0-rc.2", target: "4.0.0", updateType: "major" });
	});

	it("allows a newer prerelease of the same base for an unstable current", () => {
		expect(
			resolveUpdate(
				"4.0.0-rc.2",
				["4.0.0-rc.2", "4.0.0-rc.3", "4.1.0-alpha.1"],
				"3.9.0",
			),
		).toEqual({
			current: "4.0.0-rc.2",
			target: "4.0.0-rc.3",
			updateType: "prerelease",
		});
	});

	it("respects the latest dist-tag and does not overshoot it", () => {
		expect(
			resolveUpdate("1.0.0", ["1.0.0", "1.1.0", "2.0.0"], "1.1.0"),
		).toEqual({ current: "1.0.0", target: "1.1.0", updateType: "minor" });
	});

	it("can be forced past latest by opting out of respectLatest", () => {
		expect(
			resolveUpdate("1.0.0", ["1.0.0", "1.1.0", "2.0.0"], "1.1.0", {
				respectLatest: false,
			}),
		).toEqual({ current: "1.0.0", target: "2.0.0", updateType: "major" });
	});

	it("can be forced onto a prerelease by opting out of ignoreUnstable", () => {
		expect(
			resolveUpdate("1.2.0", ["1.2.0", "1.3.0-rc.1"], "1.3.0-rc.1", {
				ignoreUnstable: false,
			}),
		).toEqual({
			current: "1.2.0",
			target: "1.3.0-rc.1",
			updateType: "preminor",
		});
	});

	it("returns null for a non-semver current version", () => {
		expect(resolveUpdate("workspace:*", ["1.0.0"], "1.0.0")).toBeNull();
	});
});

describe("effectiveMinimumReleaseAge", () => {
	it("forces the 3-day floor when nothing is configured", () => {
		expect(effectiveMinimumReleaseAge(null)).toEqual({
			ms: THREE_DAYS_MS,
			forced: true,
		});
	});

	it("forces the 3-day floor when the configured value is below it", () => {
		expect(effectiveMinimumReleaseAge(24 * 60 * 60 * 1000)).toEqual({
			ms: THREE_DAYS_MS,
			forced: true,
		});
	});

	it("keeps a configured value that meets or exceeds the floor", () => {
		expect(effectiveMinimumReleaseAge(THREE_DAYS_MS)).toEqual({
			ms: THREE_DAYS_MS,
			forced: false,
		});
		const sevenDays = 7 * 24 * 60 * 60 * 1000;
		expect(effectiveMinimumReleaseAge(sevenDays)).toEqual({
			ms: sevenDays,
			forced: false,
		});
	});
});

describe("resolveUpdateStatus", () => {
	const times = { "1.1.0": AGED, "1.2.0": FRESH };

	it("returns null when there is no newer version", () => {
		expect(
			resolveUpdateStatus("1.0.0", ["1.0.0"], {}, "1.0.0", THREE_DAYS_MS, NOW),
		).toBeNull();
	});

	it("marks the update safe when the newest version has aged in", () => {
		expect(
			resolveUpdateStatus(
				"1.0.0",
				["1.0.0", "1.1.0"],
				times,
				"1.1.0",
				THREE_DAYS_MS,
				NOW,
			),
		).toEqual({
			current: "1.0.0",
			target: "1.1.0",
			updateType: "minor",
			state: "safe",
		});
	});

	it("holds back a newer version that is still too fresh", () => {
		expect(
			resolveUpdateStatus(
				"1.0.0",
				["1.0.0", "1.1.0", "1.2.0"],
				times,
				"1.2.0",
				THREE_DAYS_MS,
				NOW,
			),
		).toEqual({
			current: "1.0.0",
			target: "1.1.0",
			updateType: "minor",
			state: "safe-newer-held",
			heldVersion: "1.2.0",
		});
	});

	it("reports held when the only available update is too fresh", () => {
		expect(
			resolveUpdateStatus(
				"1.0.0",
				["1.0.0", "1.2.0"],
				times,
				"1.2.0",
				THREE_DAYS_MS,
				NOW,
			),
		).toEqual({
			current: "1.0.0",
			target: null,
			updateType: "minor",
			state: "held",
			heldVersion: "1.2.0",
		});
	});

	it("treats an unknown publish time as too fresh (paranoid)", () => {
		expect(
			resolveUpdateStatus(
				"1.0.0",
				["1.0.0", "1.1.0"],
				{},
				"1.1.0",
				THREE_DAYS_MS,
				NOW,
			),
		).toEqual({
			current: "1.0.0",
			target: null,
			updateType: "minor",
			state: "held",
			heldVersion: "1.1.0",
		});
	});
});

describe("fetchOutdated", () => {
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

		const updates = await fetchOutdated(
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
