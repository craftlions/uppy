import type {
	Dependency,
	OutdatedInfo,
	UpdateRecord,
	UpdateStatus,
} from "./deps.ts";
import { getVersionsBatch } from "fast-npm-meta";
import { compare, diff, gt, parse, valid } from "semver";

/**
 * Renovate's default stability knobs. See
 * https://docs.renovatebot.com/configuration-options/#ignoreunstable and
 * https://docs.renovatebot.com/configuration-options/#respectlatest.
 */
export interface ResolveOptions {
	/**
	 * Skip unstable (prerelease) target versions unless the current version is
	 * itself an unstable prerelease of the same `major.minor.patch`.
	 *
	 * @default true
	 */
	ignoreUnstable?: boolean;
	/**
	 * Don't update beyond the version tagged `latest` on the registry, unless the
	 * current version already sits ahead of `latest`.
	 *
	 * @default true
	 */
	respectLatest?: boolean;
}

/** The npm.antfu.dev endpoint caps each batch lookup; chunk requests to match. */
const BATCH_SIZE = 50;

const isUnstable = (version: { prerelease: readonly unknown[] }): boolean =>
	version.prerelease.length > 0;

/**
 * Every version newer than `current` that Renovate's default policy would accept
 * as an update target, sorted ascending. Mirrors Renovate's defaults: unstable
 * versions are ignored unless `current` is already an unstable prerelease of the
 * same `major.minor.patch` (so a bump never jumps across prerelease tracks), and
 * updates never overshoot the `latest` dist-tag.
 */
function acceptableUpdates(
	current: string,
	versions: string[],
	latest: string,
	options: ResolveOptions = {},
): string[] {
	const { ignoreUnstable = true, respectLatest = true } = options;

	const currentVersion = parse(current);
	if (!currentVersion) {
		return [];
	}
	const currentUnstable = isUnstable(currentVersion);

	const respectsLatest =
		respectLatest && valid(latest) !== null && !gt(current, latest);

	const sameBaseAsCurrent = (candidate: ReturnType<typeof parse>): boolean =>
		candidate !== null &&
		candidate.major === currentVersion.major &&
		candidate.minor === currentVersion.minor &&
		candidate.patch === currentVersion.patch;

	const candidates: string[] = [];
	for (const version of versions) {
		const candidate = parse(version);
		if (!(candidate && gt(version, current))) {
			continue;
		}
		if (respectsLatest && gt(version, latest)) {
			continue;
		}
		// ignoreUnstable: only allow a prerelease target when the current version
		// is already a prerelease sharing the same major.minor.patch.
		if (
			ignoreUnstable &&
			isUnstable(candidate) &&
			!(currentUnstable && sameBaseAsCurrent(candidate))
		) {
			continue;
		}
		candidates.push(version);
	}

	return candidates.sort((a, b) => compare(a, b));
}

/**
 * Resolve the version Renovate's default policy would update `current` to,
 * given the registry's known `versions` and its `latest` dist-tag. Returns
 * `null` when the dependency is already up to date (or can't be reasoned about).
 */
export function resolveUpdate(
	current: string,
	versions: string[],
	latest: string,
	options: ResolveOptions = {},
): OutdatedInfo | null {
	const best = acceptableUpdates(current, versions, latest, options).at(-1);
	if (best === undefined) {
		return null;
	}
	return {
		current,
		target: best,
		updateType: diff(current, best) ?? "patch",
	};
}

/** Three days in milliseconds: the minimum release age Uppy always enforces. */
export const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

/** A resolved minimum release age plus whether Uppy had to force its floor. */
export interface EffectiveMinimumReleaseAge {
	/** The minimum release age to apply, in milliseconds. */
	ms: number;
	/**
	 * `true` when the configured value was missing or below the 3-day floor, so
	 * Uppy raised it to 3 days (the paranoid security default).
	 */
	forced: boolean;
}

/**
 * Apply Uppy's paranoid floor to a configured npm minimum release age: any
 * value below 3 days (or none at all) is forced up to 3 days.
 */
export function effectiveMinimumReleaseAge(
	configuredMs: number | null,
): EffectiveMinimumReleaseAge {
	if (configuredMs === null || configuredMs < THREE_DAYS_MS) {
		return { ms: THREE_DAYS_MS, forced: true };
	}
	return { ms: configuredMs, forced: false };
}

/**
 * Whether a version published at `time` has aged past `minAgeMs` as of `now`.
 * A missing or unparseable publish time is treated as not yet safe (paranoid).
 */
function isAged(
	time: string | undefined,
	now: number,
	minAgeMs: number,
): boolean {
	if (!time) {
		return false;
	}
	const published = Date.parse(time);
	if (Number.isNaN(published)) {
		return false;
	}
	return now - published >= minAgeMs;
}

/**
 * Resolve an update for `current` that also respects a minimum release age.
 * Returns the safest acceptable target alongside its state (see
 * {@link UpdateStatus}), or `null` when there is no newer acceptable version.
 *
 * `times` maps each version to its ISO publish timestamp; versions without a
 * known timestamp are treated as too fresh to recommend.
 */
export function resolveUpdateStatus(
	current: string,
	versions: string[],
	times: Record<string, string | undefined>,
	latest: string,
	minAgeMs: number,
	now: number,
	options: ResolveOptions = {},
): UpdateStatus | null {
	const candidates = acceptableUpdates(current, versions, latest, options);
	const newest = candidates.at(-1);
	if (newest === undefined) {
		return null;
	}

	// Candidates are sorted ascending, so the last aged one is the highest safe.
	let safeTarget: string | null = null;
	for (const version of candidates) {
		if (isAged(times[version], now, minAgeMs)) {
			safeTarget = version;
		}
	}

	if (safeTarget === null) {
		return {
			current,
			target: null,
			updateType: diff(current, newest) ?? "patch",
			state: "held",
			heldVersion: newest,
		};
	}
	if (safeTarget === newest) {
		return {
			current,
			target: safeTarget,
			updateType: diff(current, safeTarget) ?? "patch",
			state: "safe",
		};
	}
	return {
		current,
		target: safeTarget,
		updateType: diff(current, safeTarget) ?? "patch",
		state: "safe-newer-held",
		heldVersion: newest,
	};
}

/**
 * Render the GitHub `[!NOTE]` callout explaining that Uppy enforced its paranoid
 * 3-day minimum release age. Shown on top of the dashboard whenever the floor
 * was forced (the configured value was missing or below 3 days).
 */
export function renderMinimumReleaseAgeNote(): string {
	return `> [!NOTE]
> Uppy enforces a paranoid minimum release age of **3 days** before recommending updates, to limit exposure to supply-chain attacks on freshly published versions. Newer releases are held back (⏳) until they age past this window.`;
}

/** Options controlling the registry update check, including the age policy. */
export interface OutdatedOptions extends ResolveOptions {
	/**
	 * Minimum release age to enforce, in milliseconds. Defaults to the 3-day
	 * floor; callers pass the value from {@link effectiveMinimumReleaseAge}.
	 */
	minimumReleaseAgeMs?: number;
	/** Current time in milliseconds; injectable for deterministic tests. */
	now?: number;
}

/**
 * Look up the latest registry metadata (including per-version publish times) for
 * the given npm dependencies and return a map of package name to the update it
 * should receive, accounting for the minimum release age. Dependencies that are
 * already up to date (or fail to resolve) are omitted.
 */
export async function fetchOutdated(
	dependencies: Dependency[],
	options: OutdatedOptions = {},
): Promise<UpdateRecord> {
	const {
		minimumReleaseAgeMs = THREE_DAYS_MS,
		now = Date.now(),
		...resolveOptions
	} = options;

	const currentByName: Record<string, string> = {};
	for (const dep of dependencies) {
		if (!(dep.name in currentByName)) {
			currentByName[dep.name] = dep.version;
		}
	}

	const names = Object.keys(currentByName);
	const chunks: string[][] = [];
	for (let i = 0; i < names.length; i += BATCH_SIZE) {
		chunks.push(names.slice(i, i + BATCH_SIZE));
	}

	const batches = await Promise.all(
		chunks.map((chunk) => getVersionsBatch(chunk, { metadata: true })),
	);

	const updates: UpdateRecord = {};
	for (const entry of batches.flat()) {
		const current = currentByName[entry.name];
		const latest = entry.distTags?.latest;
		if (!(current && latest)) {
			continue;
		}
		const versionsMeta = entry.versionsMeta ?? {};
		const versions = Object.keys(versionsMeta);
		const times: Record<string, string | undefined> = {};
		for (const [version, meta] of Object.entries(versionsMeta)) {
			times[version] = meta?.time;
		}
		const status = resolveUpdateStatus(
			current,
			versions,
			times,
			latest,
			minimumReleaseAgeMs,
			now,
			resolveOptions,
		);
		if (status) {
			updates[entry.name] = status;
		}
	}

	return updates;
}
