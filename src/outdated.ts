import type { OutdatedInfo, UpdateStatus } from "./deps.ts";
import { semverVersioning, type Versioning } from "./versioning.ts";

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

/**
 * Every version newer than `current` that Renovate's default policy would accept
 * as an update target, sorted ascending. Mirrors Renovate's defaults: unstable
 * versions are ignored unless `current` is already an unstable prerelease of the
 * same base (so a bump never jumps across prerelease tracks), and updates never
 * overshoot the `latest` dist-tag. The supplied {@link Versioning} decides what
 * "newer", "stable", and "same base" mean for the ecosystem.
 */
function acceptableUpdates(
	current: string,
	versions: string[],
	latest: string,
	versioning: Versioning,
	options: ResolveOptions = {},
): string[] {
	const { ignoreUnstable = true, respectLatest = true } = options;

	if (!versioning.isValid(current)) {
		return [];
	}
	const currentStable = versioning.isStable(current);

	const respectsLatest =
		respectLatest &&
		versioning.isValid(latest) &&
		!(versioning.compare(current, latest) > 0);

	const candidates: string[] = [];
	for (const version of versions) {
		if (!versioning.isUpgrade(current, version)) {
			continue;
		}
		if (respectsLatest && versioning.compare(version, latest) > 0) {
			continue;
		}
		// ignoreUnstable: only allow a prerelease target when the current version
		// is already a prerelease sharing the same base.
		if (
			ignoreUnstable &&
			!versioning.isStable(version) &&
			!(!currentStable && versioning.isSameBase(version, current))
		) {
			continue;
		}
		candidates.push(version);
	}

	return candidates.sort((a, b) => versioning.compare(a, b));
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
	versioning: Versioning = semverVersioning,
): OutdatedInfo | null {
	const best = acceptableUpdates(
		current,
		versions,
		latest,
		versioning,
		options,
	).at(-1);
	if (best === undefined) {
		return null;
	}
	return {
		current,
		target: best,
		updateType: versioning.difference(current, best) ?? "patch",
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
	versioning: Versioning = semverVersioning,
): UpdateStatus | null {
	const candidates = acceptableUpdates(
		current,
		versions,
		latest,
		versioning,
		options,
	);
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
			updateType: versioning.difference(current, newest) ?? "patch",
			state: "held",
			heldVersion: newest,
		};
	}
	if (safeTarget === newest) {
		return {
			current,
			target: safeTarget,
			updateType: versioning.difference(current, safeTarget) ?? "patch",
			state: "safe",
		};
	}
	return {
		current,
		target: safeTarget,
		updateType: versioning.difference(current, safeTarget) ?? "patch",
		state: "safe-newer-held",
		heldVersion: newest,
	};
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
