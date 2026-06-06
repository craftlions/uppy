import {
	type Dependency,
	dependencyKey,
	type UpdateRecord,
	type UpdateStatus,
} from "./deps.ts";
import {
	type OutdatedOptions,
	resolveUpdateStatus,
	THREE_DAYS_MS,
} from "./outdated.ts";
import { semverVersioning, type Versioning } from "./versioning.ts";

/**
 * The version metadata a {@link Datasource} returns for a single dependency: the
 * released versions, each one's publish time, and the version tagged `latest`.
 * The datasource is responsible for producing `latest` — npm reads it from the
 * registry's dist-tags, mise synthesizes it — so the resolver never learns which
 * one was real and which was derived.
 *
 * The `current*` and `digests` fields are populated only by datasources that
 * resolve a ref into a different version space than the manifest wrote — today
 * that is `github-tags`, which turns a commit sha or floating tag into a concrete
 * version and a sha to pin to. npm and mise leave them unset.
 */
export interface VersionInfo {
	/** Every released version known to the datasource. */
	versions: string[];
	/** Maps each version to its ISO publish timestamp, when known. */
	times: Record<string, string | undefined>;
	/**
	 * The version the datasource considers `latest`. May be `""` when the
	 * datasource cannot determine one, which simply disables the `respectLatest`
	 * guard for that dependency.
	 */
	latest: string;
	/**
	 * The version the manifest's ref resolves to, as the datasource sees it. When
	 * unset the resolver falls back to the raw ref (npm/mise, where the ref is
	 * already the version). github-tags sets it from the sha (ground truth) or
	 * tag, and `""` when the ref resolves to no known version.
	 */
	currentVersion?: string;
	/**
	 * The commit sha the manifest is currently pinned to, or `undefined` when the
	 * ref is a floating tag/branch. github-actions only.
	 */
	currentDigest?: string;
	/**
	 * Maps a version (including {@link currentVersion}, even when coarse) to the
	 * commit sha to pin it to. github-actions only; lets the resolver attach a
	 * `targetDigest` to its recommendation.
	 */
	digests?: Record<string, string | undefined>;
}

/**
 * The lookup input for one dependency: its name, the raw manifest ref, and the
 * key its {@link VersionInfo} should be returned under. The key keeps occurrences
 * of the same action at different refs distinct (see {@link dependencyKey}); when
 * omitted the datasource falls back to the name.
 */
export interface DependencyRef {
	name: string;
	ref: string;
	key?: string;
}

/**
 * One ecosystem's source of version metadata. Given the dependencies' names and
 * refs, it returns the {@link VersionInfo} for each name it can resolve, omitting
 * the rest. The interface is batch-shaped so each adapter owns its own round-trip
 * strategy — npm chunks names into capped batch requests, mise fans out one
 * request per tool, github-tags batches one GraphQL query per repo — without the
 * resolver knowing the difference. A datasource declares the {@link Versioning}
 * it speaks; the resolver defaults to {@link semverVersioning} when none is set.
 */
export interface Datasource {
	readonly versioning?: Versioning;
	lookup(refs: DependencyRef[]): Promise<Map<string, VersionInfo>>;
}

/**
 * Layer the github-actions digest dimension onto a version-only update status.
 *
 * For datasources without digests (npm, mise) the version status is returned
 * unchanged. For github-tags, the recommendation is always "pin to the sha of the
 * safest acceptable version": the resolved `target` when an aged update exists,
 * otherwise the current version (pinning the current version is never age-gated —
 * only advancing to a newer tag is). A dependency that is up to date *and* already
 * pinned to that sha is omitted; one that floats on a tag, or is pinned to a stale
 * sha, surfaces a `digest` recommendation even with no version change.
 */
function composeDigestStatus(
	info: VersionInfo,
	current: string,
	status: UpdateStatus | null,
): UpdateStatus | null {
	const hasDigests =
		info.digests !== undefined || info.currentDigest !== undefined;
	if (!hasDigests) {
		return status;
	}

	const pinVersion = status?.target ?? current;
	const targetDigest = info.digests?.[pinVersion] ?? info.currentDigest;
	const currentDigest = info.currentDigest;

	if (status) {
		return { ...status, currentDigest, targetDigest };
	}
	if (targetDigest !== undefined && currentDigest !== targetDigest) {
		return {
			current,
			target: current,
			updateType: "digest",
			state: "safe",
			currentDigest,
			targetDigest,
		};
	}
	return null;
}

/**
 * Resolve the updates a set of dependencies should receive from a single
 * {@link Datasource}, accounting for the minimum release age. The source-agnostic
 * core every `fetchOutdated*` is built on: it dedupes by {@link dependencyKey}
 * (so an action pinned at two different refs stays two entries, while a name that
 * is unique within a manifest set collapses as before), looks the refs up through
 * the datasource, classifies each with {@link resolveUpdateStatus} using the
 * datasource's {@link Versioning}, then layers on any digest recommendation.
 * Dependencies that are already up to date (and, for actions, correctly pinned)
 * or have no resolvable metadata are omitted. The returned record is keyed by
 * `dependencyKey`, which consumers use to look an occurrence back up.
 */
export async function fetchOutdated(
	dependencies: Dependency[],
	datasource: Datasource,
	options: OutdatedOptions = {},
): Promise<UpdateRecord> {
	const {
		minimumReleaseAgeMs = THREE_DAYS_MS,
		now = Date.now(),
		...resolveOptions
	} = options;
	const versioning: Versioning = datasource.versioning ?? semverVersioning;

	const refsByKey = new Map<string, DependencyRef>();
	for (const dep of dependencies) {
		const key = dependencyKey(dep);
		if (!refsByKey.has(key)) {
			refsByKey.set(key, {
				name: dep.lookupName ?? dep.name,
				ref: dep.version,
				key,
			});
		}
	}
	if (refsByKey.size === 0) {
		return {};
	}

	const found = await datasource.lookup([...refsByKey.values()]);

	const updates: UpdateRecord = {};
	for (const [key, { ref }] of refsByKey) {
		const info = found.get(key);
		if (!info) {
			continue;
		}
		const current = info.currentVersion ?? ref;
		if (!current || info.versions.length === 0) {
			continue;
		}
		const status = resolveUpdateStatus(
			current,
			info.versions,
			info.times,
			info.latest,
			minimumReleaseAgeMs,
			now,
			resolveOptions,
			versioning,
		);
		const composed = composeDigestStatus(info, current, status);
		if (composed) {
			updates[key] = composed;
		}
	}

	return updates;
}
