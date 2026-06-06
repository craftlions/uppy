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
	const slug = [upgrade.ecosystem, upgrade.package, upgrade.target].map(
		branchSegment,
	);
	return `uppy/${slug.join("-")}`;
}
