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
 *
 * The hash covers the full update identity — each package paired with its
 * current and target versions — not just the package set. This mirrors how
 * {@link safeUpgradeBranch} folds `target` into a single-package branch name:
 * a later grouped upgrade for the same group/package set but newer targets
 * produces a distinct branch, so the closed-PR short-circuit suppresses only
 * the exact grouped update a closed PR represented and a new safe upgrade can
 * still open a fresh PR (see https://github.com/craftlions/uppy/issues/25).
 *
 * Tuples are sorted so the branch is stable regardless of upgrade order.
 */
export function safeUpgradeGroupBranch(
	manager: string,
	groupName: string,
	upgrades: SafeUpgrade[],
): string {
	const slug = branchSegment(groupName);
	const identity = upgrades
		.map((u) => `${u.package}@${u.current}->${u.target}`)
		.sort()
		.join("\0");
	const hash = createHash("sha256").update(identity).digest("hex").slice(0, 7);
	return `uppy/${branchSegment(manager)}-group-${slug}-${hash}`;
}
