import type { SafeUpgrade } from "../deps.ts";
import { createHash } from "node:crypto";

const REFNAME_UNSAFE = /[^A-Za-z0-9._-]+/g;
const EDGE_DOTS = /^\.+|\.+$/g;

function branchSegment(value: string): string {
	return (
		value
			.replace(REFNAME_UNSAFE, "-")
			.replace(EDGE_DOTS, "")
			.replace(/-+/g, "-") || "dependency"
	);
}

export function safeUpgradeBranch(upgrade: SafeUpgrade): string {
	const slug = [upgrade.manager, upgrade.package, upgrade.target].map(
		branchSegment,
	);
	return `uppy/${slug.join("-")}`;
}

/**
 * Whether a set of upgrades dispatched together forms a grouped PR. A single
 * upgrade carrying a `groupName` is still grouped — it shares the grouped branch
 * shape so a later run that adds a sibling package reuses the same group PR.
 */
export function upgradesAreGrouped(upgrades: SafeUpgrade[]): boolean {
	return upgrades.length > 1 || upgrades[0]?.groupName !== undefined;
}

/**
 * The branch a set of dispatched-together upgrades publishes to. The single
 * source of truth shared by the Manager workflow (which creates the branch) and
 * the orchestrator's PR reconciliation (which must predict it), so the two
 * cannot drift on branch shape.
 */
export function resolveUpgradeBranch(upgrades: SafeUpgrade[]): string {
	const first = upgrades[0];
	if (!first) {
		throw new Error("Cannot resolve branch for empty upgrade list");
	}
	if (upgradesAreGrouped(upgrades)) {
		return safeUpgradeGroupBranch(
			first.manager,
			first.groupName ?? "group",
			upgrades,
		);
	}
	return safeUpgradeBranch(first);
}

/**
 * Deterministic, collision-resistant branch name for a grouped upgrade.
 * Includes a short hash of the sorted package names so two different groups
 * with the same slug do not collide.
 */
export function safeUpgradeGroupBranch(
	manager: string,
	groupName: string,
	upgrades: SafeUpgrade[],
): string {
	const slug = branchSegment(groupName);
	const packages = upgrades
		.map((u) => u.package)
		.sort()
		.join("\0");
	const hash = createHash("sha256").update(packages).digest("hex").slice(0, 7);
	return `uppy/${branchSegment(manager)}-group-${slug}-${hash}`;
}
