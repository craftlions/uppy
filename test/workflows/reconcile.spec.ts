import type { SafeUpgrade } from "../../src/deps.ts";
import { describe, expect, it } from "vitest";
import { safeUpgradeBranch } from "../../src/workflows/branches.ts";
import {
	BLOCKED_COMMENT_MARKER,
	BLOCKED_WARNING_END,
	BLOCKED_WARNING_START,
	buildDesiredGroups,
	describeOpenPr,
	hasBlockedComment,
	type OpenUppyPr,
	parsePrUpgradePackages,
	parseUppyBranch,
	reconcileDesiredGroups,
	renderBlockedComment,
	upsertBlockedWarning,
} from "../../src/workflows/reconcile.ts";

/** Describe an open PR, asserting it parsed as an uppy PR (never null here). */
function openPr(pr: {
	number: number;
	head: { ref: string };
	body: string;
}): OpenUppyPr {
	const described = describeOpenPr(pr);
	if (!described) {
		throw new Error(`expected ${pr.head.ref} to parse as an uppy PR`);
	}
	return described;
}

function upgrade(overrides: Partial<SafeUpgrade>): SafeUpgrade {
	return {
		manager: "npm",
		manifest: "package.json",
		package: "x",
		current: "1.0.0",
		target: "1.1.0",
		updateType: "minor",
		...overrides,
	};
}

/** Build the structured PR body the orchestrator renders, for parse round-trips. */
function bodyWithTable(
	rows: { package: string; from: string; to: string; manifest?: string }[],
): string {
	return [
		"| Package | From | To | Manifest | Bump type |",
		"| --- | --- | --- | --- | --- |",
		...rows.map(
			(r) =>
				`| \`${r.package}\` | \`${r.from}\` | \`${r.to}\` | \`${r.manifest ?? "package.json"}\` | minor |`,
		),
		"",
		"```diff",
		"-old",
		"+new",
		"```",
	].join("\n");
}

describe("parseUppyBranch", () => {
	it("recovers manager and target shape from an ungrouped branch", () => {
		expect(parseUppyBranch("uppy/npm-x-1.2.0")).toEqual({
			manager: "npm",
			grouped: false,
			groupSlug: null,
		});
	});

	it("keeps a hyphenated manager intact and extracts the group slug", () => {
		expect(parseUppyBranch("uppy/github-actions-group-Astro-abc1234")).toEqual({
			manager: "github-actions",
			grouped: true,
			groupSlug: "Astro",
		});
	});

	it("returns no manager for a non-uppy branch", () => {
		expect(parseUppyBranch("feature/foo")).toEqual({
			manager: null,
			grouped: false,
			groupSlug: null,
		});
	});
});

describe("parsePrUpgradePackages", () => {
	it("reads the package column out of the structured upgrade table", () => {
		const body = bodyWithTable([
			{ package: "astro", from: "1.0.0", to: "1.1.0" },
			{ package: "@astrojs/rss", from: "1.0.0", to: "1.1.0" },
		]);
		expect(parsePrUpgradePackages(body)).toEqual(["astro", "@astrojs/rss"]);
	});

	it("returns an empty list when the body has no table", () => {
		expect(parsePrUpgradePackages("just some prose")).toEqual([]);
	});
});

describe("buildDesiredGroups", () => {
	it("predicts the ungrouped branch the Manager workflow will publish", () => {
		const up = upgrade({ package: "x", target: "1.2.0" });
		const groups = buildDesiredGroups([up]);
		expect(groups).toHaveLength(1);
		expect(groups[0]?.branch).toBe(safeUpgradeBranch(up));
		expect(groups[0]?.packages).toEqual(["x"]);
	});

	it("collapses upgrades sharing a group name into one group", () => {
		const groups = buildDesiredGroups([
			upgrade({ package: "astro", groupName: "Astro" }),
			upgrade({ package: "@astrojs/rss", groupName: "Astro" }),
		]);
		expect(groups).toHaveLength(1);
		expect(groups[0]?.packages).toEqual(["astro", "@astrojs/rss"]);
		expect(groups[0]?.branch).toMatch(/^uppy\/npm-group-Astro-[0-9a-f]{7}$/);
	});
});

describe("reconcileDesiredGroups", () => {
	it("blocks a newer exact update behind the older open PR for the same package", () => {
		const open = openPr({
			number: 5,
			head: { ref: "uppy/npm-x-1.1.0" },
			body: bodyWithTable([{ package: "x", from: "1.0.0", to: "1.1.0" }]),
		});
		const groups = buildDesiredGroups([
			upgrade({ package: "x", target: "1.2.0" }),
		]);
		const [result] = reconcileDesiredGroups(groups, [open]);
		expect(result?.blockedBy?.number).toBe(5);
	});

	it("does not block when the desired branch already matches the open PR", () => {
		const open = openPr({
			number: 5,
			head: { ref: "uppy/npm-x-1.1.0" },
			body: bodyWithTable([{ package: "x", from: "1.0.0", to: "1.1.0" }]),
		});
		const groups = buildDesiredGroups([
			upgrade({ package: "x", target: "1.1.0" }),
		]);
		const [result] = reconcileDesiredGroups(groups, [open]);
		expect(result?.blockedBy).toBeUndefined();
	});

	it("does not block an unrelated package", () => {
		const open = openPr({
			number: 5,
			head: { ref: "uppy/npm-x-1.1.0" },
			body: bodyWithTable([{ package: "x", from: "1.0.0", to: "1.1.0" }]),
		});
		const groups = buildDesiredGroups([
			upgrade({ package: "y", target: "1.2.0" }),
		]);
		const [result] = reconcileDesiredGroups(groups, [open]);
		expect(result?.blockedBy).toBeUndefined();
	});

	it("blocks a newer grouped update behind an older open PR for the same group", () => {
		const open = openPr({
			number: 7,
			head: { ref: "uppy/npm-group-Astro-aaaaaaa" },
			body: bodyWithTable([
				{ package: "astro", from: "1.0.0", to: "1.1.0" },
				{ package: "@astrojs/rss", from: "1.0.0", to: "1.1.0" },
			]),
		});
		// A newer grouped run adds a package, changing the branch hash but not intent.
		const groups = buildDesiredGroups([
			upgrade({ package: "astro", groupName: "Astro", target: "1.2.0" }),
			upgrade({ package: "@astrojs/rss", groupName: "Astro", target: "1.2.0" }),
			upgrade({
				package: "@astrojs/check",
				groupName: "Astro",
				target: "1.0.1",
			}),
		]);
		const [result] = reconcileDesiredGroups(groups, [open]);
		expect(result?.blockedBy?.number).toBe(7);
	});

	it("blocks on the oldest conflicting PR when several overlap", () => {
		const newer = openPr({
			number: 9,
			head: { ref: "uppy/npm-x-1.2.0" },
			body: bodyWithTable([{ package: "x", from: "1.0.0", to: "1.2.0" }]),
		});
		const older = openPr({
			number: 4,
			head: { ref: "uppy/npm-x-1.1.0" },
			body: bodyWithTable([{ package: "x", from: "1.0.0", to: "1.1.0" }]),
		});
		const groups = buildDesiredGroups([
			upgrade({ package: "x", target: "1.3.0" }),
		]);
		const [result] = reconcileDesiredGroups(groups, [newer, older]);
		expect(result?.blockedBy?.number).toBe(4);
	});

	it("blocks on an older conflicting PR even when a newer exact-branch PR exists", () => {
		// Two concurrent runs left #5 (x→1.1.0) and #9 (x→1.2.0) open. A desired
		// group targeting #9's exact branch must still be blocked by the older #5.
		const older = openPr({
			number: 5,
			head: { ref: "uppy/npm-x-1.1.0" },
			body: bodyWithTable([{ package: "x", from: "1.0.0", to: "1.1.0" }]),
		});
		const newerExact = openPr({
			number: 9,
			head: { ref: "uppy/npm-x-1.2.0" },
			body: bodyWithTable([{ package: "x", from: "1.0.0", to: "1.2.0" }]),
		});
		const groups = buildDesiredGroups([
			upgrade({ package: "x", target: "1.2.0" }),
		]);
		const [result] = reconcileDesiredGroups(groups, [older, newerExact]);
		expect(result?.blockedBy?.number).toBe(5);
	});

	it("ignores non-uppy PRs entirely", () => {
		expect(
			describeOpenPr({ number: 1, head: { ref: "feature/x" }, body: "" }),
		).toBeNull();
	});

	it("does not let an unknown-manager PR block via package overlap", () => {
		// A grouped branch for a manager no longer in the binding map: its packages
		// overlap the desired npm group, but the managers differ, so it must not block.
		const stale = openPr({
			number: 3,
			head: { ref: "uppy/cargo-group-stuff-aaaaaaa" },
			body: bodyWithTable([{ package: "x", from: "1.0.0", to: "1.1.0" }]),
		});
		expect(stale.manager).toBe("cargo");
		const groups = buildDesiredGroups([
			upgrade({ package: "x", target: "1.2.0" }),
		]);
		const [result] = reconcileDesiredGroups(groups, [stale]);
		expect(result?.blockedBy).toBeUndefined();
	});
});

describe("blocked PR annotation", () => {
	const upgrades = [upgrade({ package: "x", target: "1.2.0" })];

	it("renders a comment carrying the dedupe marker and the newer target", () => {
		const comment = renderBlockedComment(upgrades);
		expect(comment).toContain(BLOCKED_COMMENT_MARKER);
		expect(comment).toContain("1.2.0");
	});

	it("lists every held-back upgrade when one PR blocks several groups", () => {
		const comment = renderBlockedComment([
			upgrade({ package: "x", target: "1.2.0" }),
			upgrade({ package: "y", target: "2.0.0" }),
		]);
		expect(comment).toContain("`x` → `1.2.0`");
		expect(comment).toContain("`y` → `2.0.0`");
	});

	it("detects an already-posted comment so it is added at most once", () => {
		expect(hasBlockedComment([{ body: renderBlockedComment(upgrades) }])).toBe(
			true,
		);
		expect(hasBlockedComment([{ body: "unrelated chatter" }])).toBe(false);
		expect(hasBlockedComment([])).toBe(false);
	});

	it("prepends the warning block and preserves the original body", () => {
		const updated = upsertBlockedWarning("Original PR body.", upgrades);
		expect(updated.startsWith(BLOCKED_WARNING_START)).toBe(true);
		expect(updated).toContain(BLOCKED_WARNING_END);
		expect(updated).toContain("Original PR body.");
	});

	it("refreshes the warning block in place without duplicating it", () => {
		const once = upsertBlockedWarning("Original PR body.", upgrades);
		const twice = upsertBlockedWarning(once, upgrades);
		expect(twice.split(BLOCKED_WARNING_START)).toHaveLength(2);
		expect(twice.split(BLOCKED_WARNING_END)).toHaveLength(2);
		expect(twice).toContain("Original PR body.");
	});
});
