import type { SafeUpgrade } from "../deps.ts";
import { branchSegment, resolveUpgradeBranch } from "./branches.ts";
import { MANAGER_WORKFLOW_BINDINGS } from "./dispatch.ts";

/**
 * The branch prefix every uppy-authored upgrade branch carries. The Uppy-owned
 * signal we use to tell our own PRs apart from human-authored or unrelated ones
 * without trusting PR titles. The Dependency Dashboard is an issue, not a PR, so
 * it never reaches this path — but the prefix is a second guard regardless.
 */
export const UPPY_BRANCH_PREFIX = "uppy/";

/** Marker hiding in the blocked-update comment so we add it at most once. */
export const BLOCKED_COMMENT_MARKER = "<!-- uppy:blocked-newer-update -->";

/** Delimiters around the idempotent warning block at the top of a blocked PR body. */
export const BLOCKED_WARNING_START = "<!-- uppy:blocked-warning:start -->";
export const BLOCKED_WARNING_END = "<!-- uppy:blocked-warning:end -->";

/**
 * One dispatched-together set of upgrades, paired with the branch it would
 * publish to. The orchestrator groups {@link SafeUpgrade}s exactly as the
 * dispatch step does, then asks {@link reconcileDesiredGroups} whether each
 * group is blocked by an already-open uppy PR.
 */
export interface DesiredGroup {
	manager: string;
	groupName?: string;
	/** Package names in this group, used for overlap-based conflict matching. */
	packages: string[];
	/** The branch this group would publish to (predicts the Manager workflow). */
	branch: string;
	upgrades: SafeUpgrade[];
}

/**
 * An open uppy PR reduced to the metadata conflict detection needs: its branch
 * (manager + grouped-ness + group slug), the package set parsed from the
 * structured PR-body upgrade table, and its number for annotation.
 */
export interface OpenUppyPr {
	number: number;
	branch: string;
	manager: string | null;
	grouped: boolean;
	groupSlug: string | null;
	packages: string[];
}

/** A desired group plus the older open PR (if any) that blocks dispatching it. */
export interface ReconciledGroup {
	group: DesiredGroup;
	/** When set, dispatch is suppressed and this existing PR is annotated. */
	blockedBy?: OpenUppyPr;
}

const KNOWN_MANAGERS = Object.keys(MANAGER_WORKFLOW_BINDINGS);

/**
 * Group desired upgrades the same way {@link UppyWorkflow}'s dispatch step does —
 * by `(manager, groupName)` for grouped upgrades, by `(manager, package)`
 * otherwise — and pair each group with the branch it would publish to. This is
 * the single grouping used for both reconciliation and dispatch so the predicted
 * branch always matches what the Manager workflow creates.
 */
export function buildDesiredGroups(
	dispatchable: SafeUpgrade[],
): DesiredGroup[] {
	const grouped = new Map<string, SafeUpgrade[]>();
	for (const upgrade of dispatchable) {
		const key = upgrade.groupName
			? `${upgrade.manager}::group::${upgrade.groupName}`
			: `${upgrade.manager}::${upgrade.package}`;
		const list = grouped.get(key) ?? [];
		list.push(upgrade);
		grouped.set(key, list);
	}

	const groups: DesiredGroup[] = [];
	for (const upgrades of grouped.values()) {
		const first = upgrades[0];
		if (!first) {
			continue;
		}
		groups.push({
			manager: first.manager,
			...(first.groupName !== undefined ? { groupName: first.groupName } : {}),
			packages: upgrades.map((u) => u.package),
			branch: resolveUpgradeBranch(upgrades),
			upgrades,
		});
	}
	return groups;
}

const GROUP_BRANCH = /^uppy\/(.+?)-group-(.+)-[0-9a-f]{7}$/;

/**
 * Recover the manager, grouped-ness, and (for grouped PRs) the group slug from
 * an uppy branch name. Mirrors {@link safeUpgradeBranch} /
 * {@link safeUpgradeGroupBranch}: ungrouped branches are
 * `uppy/<manager>-<package>-<target>` and grouped branches are
 * `uppy/<manager>-group-<slug>-<hash>`. For ungrouped branches the manager is
 * matched against the known set (the package and target also contain hyphens, so
 * the prefix is the only reliable split). Grouped branches encode the manager
 * unambiguously before `-group-`, so we read it straight from the branch — that
 * keeps manager matching accurate even for an unknown or since-removed manager.
 */
export function parseUppyBranch(branch: string): {
	manager: string | null;
	grouped: boolean;
	groupSlug: string | null;
} {
	const groupMatch = GROUP_BRANCH.exec(branch);
	if (groupMatch) {
		// Group 1 (non-greedy, up to the first `-group-`) is the manager; group 2 is
		// the slug between `<manager>-group-` and the trailing 7-char hash.
		return {
			manager: groupMatch[1] ?? null,
			grouped: true,
			groupSlug: groupMatch[2] ?? null,
		};
	}
	const manager =
		KNOWN_MANAGERS.find((name) =>
			branch.startsWith(`${UPPY_BRANCH_PREFIX}${name}-`),
		) ?? null;
	return { manager, grouped: false, groupSlug: null };
}

const TABLE_ROW = /^\|(.+)\|$/;

/**
 * Pull the package names out of the structured upgrade table
 * {@link renderPrBody} emits. The header is `| Package | From | To | … |` and
 * each row's first cell is a backtick-wrapped package name. We read the package
 * column only — it is all conflict matching needs — and tolerate bodies without
 * a table by returning an empty list.
 */
export function parsePrUpgradePackages(body: string): string[] {
	const packages: string[] = [];
	let inTable = false;
	for (const rawLine of body.split("\n")) {
		const line = rawLine.trim();
		const match = TABLE_ROW.exec(line);
		if (!match) {
			if (inTable) {
				break;
			}
			continue;
		}
		const cells = (match[1] ?? "").split("|").map((cell) => cell.trim());
		const first = cells[0] ?? "";
		if (first === "Package") {
			inTable = true;
			continue;
		}
		// The `| --- | --- |` separator row.
		if (/^-+$/.test(first)) {
			continue;
		}
		if (!inTable) {
			continue;
		}
		const pkg = first.replace(/^`|`$/g, "").trim();
		if (pkg) {
			packages.push(pkg);
		}
	}
	return packages;
}

/**
 * Describe an open PR for conflict detection, or `null` when it is not an
 * uppy-authored upgrade PR (no `uppy/` branch). Returning `null` keeps
 * human-authored and unrelated PRs out of the blocking logic entirely.
 */
export function describeOpenPr(pr: {
	number: number;
	head?: { ref?: string } | null;
	body?: string | null;
}): OpenUppyPr | null {
	const branch = pr.head?.ref ?? "";
	if (!branch.startsWith(UPPY_BRANCH_PREFIX)) {
		return null;
	}
	const { manager, grouped, groupSlug } = parseUppyBranch(branch);
	return {
		number: pr.number,
		branch,
		manager,
		grouped,
		groupSlug,
		packages: parsePrUpgradePackages(pr.body ?? ""),
	};
}

/**
 * Whether an open uppy PR represents the same dependency update intent as a
 * desired group: same manager, and either an overlapping package set or — for
 * grouped updates — the same group slug. Overlap is the core signal because a
 * later run that changes the target version (ungrouped) or the package set
 * (grouped) produces a different branch but the same intent.
 */
function conflicts(group: DesiredGroup, pr: OpenUppyPr): boolean {
	// Conflict intent is defined as the *same manager*. Require a positive match —
	// a PR whose manager could not be parsed (a malformed or since-removed-manager
	// branch) never blocks a dispatch purely on package-name overlap.
	if (group.manager !== pr.manager) {
		return false;
	}
	const slug = group.groupName ? branchSegment(group.groupName) : null;
	if (slug && pr.grouped && pr.groupSlug === slug) {
		return true;
	}
	const prPackages = new Set(pr.packages);
	return group.packages.some((pkg) => prPackages.has(pkg));
}

/**
 * Reconcile desired upgrade groups against open uppy PRs.
 *
 * For each group, an exact branch match means the open PR *is* this intent and
 * will simply be updated in place — never a conflict. Otherwise the oldest open
 * uppy PR (lowest number) that overlaps the group's dependency intent blocks it:
 * dispatch is suppressed and the caller annotates that existing PR. A group with
 * no exact match and no overlap dispatches normally.
 */
export function reconcileDesiredGroups(
	groups: DesiredGroup[],
	openPrs: OpenUppyPr[],
): ReconciledGroup[] {
	const byNumber = [...openPrs].sort((a, b) => a.number - b.number);
	return groups.map((group) => {
		const exactMatch = byNumber.find((pr) => pr.branch === group.branch);
		if (exactMatch) {
			return { group };
		}
		const blockedBy = byNumber.find((pr) => conflicts(group, pr));
		return blockedBy ? { group, blockedBy } : { group };
	});
}

/**
 * The human-readable explanation shared by the blocked PR's comment and its body
 * warning block. Names the packages and the newer target(s) being held back so
 * the user knows exactly what merging or closing this PR unblocks.
 */
function blockedExplanation(group: DesiredGroup): string {
	const targets = group.upgrades
		.map((u) => `\`${u.package}\` → \`${u.target}\``)
		.join(", ");
	return (
		"A newer dependency update is available but is **blocked** until this PR " +
		"is merged or closed. Uppy keeps at most one open PR per dependency update " +
		`intent, so it will open the newer update (${targets}) only once this PR is ` +
		"resolved."
	);
}

/** The one-time comment body posted to a blocked PR, carrying its dedupe marker. */
export function renderBlockedComment(group: DesiredGroup): string {
	return `${BLOCKED_COMMENT_MARKER}\n\n> [!NOTE]\n> ${blockedExplanation(group)}`;
}

/** Whether any existing comment already carries the blocked-update marker. */
export function hasBlockedComment(
	comments: { body?: string | null }[],
): boolean {
	return comments.some((comment) =>
		(comment.body ?? "").includes(BLOCKED_COMMENT_MARKER),
	);
}

/**
 * Prepend or refresh the idempotent warning block at the top of a PR body.
 * Repeated runs replace the content between the markers in place rather than
 * stacking duplicate warnings; the rest of the body is preserved untouched.
 */
export function upsertBlockedWarning(
	body: string,
	group: DesiredGroup,
): string {
	const block = [
		BLOCKED_WARNING_START,
		"> [!WARNING]",
		`> ${blockedExplanation(group)}`,
		BLOCKED_WARNING_END,
	].join("\n");

	const start = body.indexOf(BLOCKED_WARNING_START);
	const end = body.indexOf(BLOCKED_WARNING_END);
	if (start !== -1 && end !== -1 && end > start) {
		const before = body.slice(0, start);
		const after = body.slice(end + BLOCKED_WARNING_END.length);
		return `${before}${block}${after}`;
	}
	return `${block}\n\n${body}`;
}
