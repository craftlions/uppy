import { createHash } from "node:crypto";
import type { SafeUpgrade } from "../deps.ts";

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
	const packages = upgrades.map((u) => u.package).sort().join("\0");
	const hash = createHash("sha256").update(packages).digest("hex").slice(0, 7);
	return `uppy/${branchSegment(manager)}-group-${slug}-${hash}`;
}
