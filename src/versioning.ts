import { compare, diff, parse, valid } from "semver";

/**
 * A versioning scheme: how uppy parses a version string, orders two versions,
 * classifies a bump, and judges stability. Each {@link Datasource} declares the
 * Versioning it speaks (see CONTEXT.md), so the resolver in `./outdated.ts`
 * reasons about updates without hard-coding semver. `semver` serves npm and mise;
 * `github` tolerates a leading `v` and reads a coarse tag (`v4`) as a moving
 * track. Mirrors Renovate's `versioning` vocabulary.
 */
export interface Versioning {
	/** Whether `version` parses in this scheme. */
	isValid(version: string): boolean;
	/** Whether `version` is a stable (non-prerelease) release; invalid → false. */
	isStable(version: string): boolean;
	/**
	 * Total order over two versions: negative when `a` sorts before `b`, positive
	 * when after, zero when equal. Callers guard with {@link isValid} first.
	 */
	compare(a: string, b: string): number;
	/**
	 * Whether `candidate` is a newer release than `current` that this scheme would
	 * offer as an update. For `semver` this is a strict greater-than; for a coarse
	 * `github` tag only a higher track counts, so `v4.1.0` is not an upgrade to
	 * `v4` (it lives inside the track) but `v5` is.
	 */
	isUpgrade(current: string, candidate: string): boolean;
	/**
	 * Whether two versions share the same `major.minor.patch` base, ignoring any
	 * prerelease. Drives the `ignoreUnstable` rule that keeps a bump from jumping
	 * across prerelease tracks.
	 */
	isSameBase(a: string, b: string): boolean;
	/** The bump type from `from` to `to` (e.g. `major`), or null when indistinct. */
	difference(from: string, to: string): string | null;
}

const isStableSemver = (version: string): boolean => {
	const parsed = parse(version);
	return parsed !== null && parsed.prerelease.length === 0;
};

const sameBaseSemver = (a: string, b: string): boolean => {
	const pa = parse(a);
	const pb = parse(b);
	return (
		pa !== null &&
		pb !== null &&
		pa.major === pb.major &&
		pa.minor === pb.minor &&
		pa.patch === pb.patch
	);
};

/**
 * Plain semantic versioning, as the `semver` package implements it (a leading
 * `v` is tolerated). The Versioning npm and mise speak.
 */
export const semverVersioning: Versioning = {
	isValid: (version) => valid(version) !== null,
	isStable: isStableSemver,
	compare: (a, b) => compare(a, b),
	isUpgrade: (current, candidate) =>
		valid(candidate) !== null &&
		valid(current) !== null &&
		compare(candidate, current) > 0,
	isSameBase: sameBaseSemver,
	difference: (from, to) => diff(from, to),
};

/** A GitHub tag parsed into a full semver string plus the granularity authored. */
interface GithubTag {
	/** The tag normalized to a full `X.Y.Z[-pre]` semver string. */
	semver: string;
	/** How many numeric components the raw tag carried: 1 (`v4`), 2, or 3. */
	granularity: 1 | 2 | 3;
}

const GITHUB_TAG = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(-[0-9A-Za-z.-]+)?$/;

/**
 * Parse a GitHub Action tag like `v4`, `v4.1`, `v4.1.0`, or `v4.1.0-beta.1` into
 * a full semver string (padding missing components with `0`) and the granularity
 * the author wrote. Returns null for anything that is not a `v`-style numeric tag
 * (a branch name, a sha, a marketing tag), which leaves it digest-only.
 */
function parseGithubTag(version: string): GithubTag | null {
	const match = GITHUB_TAG.exec(version.trim());
	if (!match) {
		return null;
	}
	const [, major, minor, patch, prerelease] = match;
	const granularity = (patch !== undefined ? 3 : minor !== undefined ? 2 : 1) as
		| 1
		| 2
		| 3;
	const semver = `${major}.${minor ?? 0}.${patch ?? 0}${prerelease ?? ""}`;
	return valid(semver) === null ? null : { semver, granularity };
}

/**
 * GitHub tag versioning: tolerates the `v` prefix and treats a coarse tag as a
 * moving track. A candidate upgrades a coarse `current` only when it sits in a
 * higher track (`v4` → `v5`, never `v4` → `v4.2.0`), while a fully-qualified
 * `current` compares as ordinary semver. The Versioning the `github-tags`
 * datasource speaks.
 */
export const githubVersioning: Versioning = {
	isValid: (version) => parseGithubTag(version) !== null,
	isStable: (version) => {
		const tag = parseGithubTag(version);
		return tag !== null && isStableSemver(tag.semver);
	},
	compare: (a, b) => {
		const ta = parseGithubTag(a);
		const tb = parseGithubTag(b);
		if (!ta || !tb) {
			return 0;
		}
		return compare(ta.semver, tb.semver);
	},
	isUpgrade: (current, candidate) => {
		const cur = parseGithubTag(current);
		const cand = parseGithubTag(candidate);
		if (!cur || !cand) {
			return false;
		}
		const c = parse(cur.semver);
		const d = parse(cand.semver);
		if (!c || !d) {
			return false;
		}
		switch (cur.granularity) {
			case 1:
				return d.major > c.major;
			case 2:
				return d.major > c.major || (d.major === c.major && d.minor > c.minor);
			default:
				return compare(cand.semver, cur.semver) > 0;
		}
	},
	isSameBase: (a, b) => {
		const ta = parseGithubTag(a);
		const tb = parseGithubTag(b);
		return ta !== null && tb !== null && sameBaseSemver(ta.semver, tb.semver);
	},
	difference: (from, to) => {
		const tf = parseGithubTag(from);
		const tt = parseGithubTag(to);
		if (!tf || !tt) {
			return null;
		}
		return diff(tf.semver, tt.semver);
	},
};
