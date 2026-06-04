import type { Dependency, OutdatedInfo } from "./deps.ts";
import { getVersionsBatch } from "fast-npm-meta";
import { diff, gt, parse, valid } from "semver";

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
 * Resolve the version Renovate's default policy would update `current` to,
 * given the registry's known `versions` and its `latest` dist-tag. Returns
 * `null` when the dependency is already up to date (or can't be reasoned about).
 *
 * Mirrors Renovate's defaults: unstable versions are ignored unless `current`
 * is already an unstable prerelease of the same `major.minor.patch` (so a bump
 * never jumps across prerelease tracks), and updates never overshoot the
 * `latest` dist-tag.
 */
export function resolveUpdate(
	current: string,
	versions: string[],
	latest: string,
	options: ResolveOptions = {},
): OutdatedInfo | null {
	const { ignoreUnstable = true, respectLatest = true } = options;

	const currentVersion = parse(current);
	if (!currentVersion) {
		return null;
	}
	const currentUnstable = isUnstable(currentVersion);

	const respectsLatest =
		respectLatest && valid(latest) !== null && !gt(current, latest);

	const sameBaseAsCurrent = (candidate: ReturnType<typeof parse>): boolean =>
		candidate !== null &&
		candidate.major === currentVersion.major &&
		candidate.minor === currentVersion.minor &&
		candidate.patch === currentVersion.patch;

	let best: string | null = null;
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
		if (best === null || gt(version, best)) {
			best = version;
		}
	}

	if (best === null) {
		return null;
	}

	return {
		current,
		target: best,
		updateType: diff(current, best) ?? "patch",
	};
}

/**
 * Look up the latest registry metadata for the given npm dependencies and
 * return a map of package name to the Renovate-style update it should receive.
 * Dependencies that are already up to date (or fail to resolve) are omitted.
 */
export async function fetchOutdated(
	dependencies: Dependency[],
	options: ResolveOptions = {},
): Promise<Map<string, OutdatedInfo>> {
	const currentByName = new Map<string, string>();
	for (const dep of dependencies) {
		if (!currentByName.has(dep.name)) {
			currentByName.set(dep.name, dep.version);
		}
	}

	const names = [...currentByName.keys()];
	const chunks: string[][] = [];
	for (let i = 0; i < names.length; i += BATCH_SIZE) {
		chunks.push(names.slice(i, i + BATCH_SIZE));
	}

	const batches = await Promise.all(
		chunks.map((chunk) => getVersionsBatch(chunk, { throw: false })),
	);

	const updates = new Map<string, OutdatedInfo>();
	for (const entry of batches.flat()) {
		if ("error" in entry) {
			continue;
		}
		const current = currentByName.get(entry.name);
		const latest = entry.distTags.latest;
		if (!(current && latest)) {
			continue;
		}
		const info = resolveUpdate(current, entry.versions, latest, options);
		if (info) {
			updates.set(entry.name, info);
		}
	}

	return updates;
}
