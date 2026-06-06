import type { Dependency, UpdateRecord } from "./deps.ts";
import {
	type OutdatedOptions,
	resolveUpdateStatus,
	THREE_DAYS_MS,
} from "./outdated.ts";

/**
 * The version metadata a {@link Datasource} returns for a single dependency: the
 * released versions, each one's publish time, and the version tagged `latest`.
 * The datasource is responsible for producing `latest` — npm reads it from the
 * registry's dist-tags, mise synthesizes it — so the resolver never learns which
 * one was real and which was derived.
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
}

/**
 * One ecosystem's source of version metadata. Given a set of dependency names,
 * it returns the {@link VersionInfo} for each name it can resolve, omitting the
 * rest. The interface is batch-shaped so each adapter owns its own round-trip
 * strategy — npm chunks names into capped batch requests, mise fans out one
 * request per tool — without the resolver knowing the difference.
 */
export interface Datasource {
	lookup(names: string[]): Promise<Map<string, VersionInfo>>;
}

/**
 * Resolve the updates a set of dependencies should receive from a single
 * {@link Datasource}, accounting for the minimum release age. The source-agnostic
 * core both `fetchOutdatedNpm` and `fetchOutdatedMise` are built on: it dedupes
 * names (first version wins), looks them up through the datasource, classifies
 * each with {@link resolveUpdateStatus}, and omits dependencies that are already
 * up to date or have no resolvable metadata.
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

	const currentByName: Record<string, string> = {};
	for (const dep of dependencies) {
		if (!(dep.name in currentByName)) {
			currentByName[dep.name] = dep.version;
		}
	}

	const names = Object.keys(currentByName);
	if (names.length === 0) {
		return {};
	}

	const found = await datasource.lookup(names);

	const updates: UpdateRecord = {};
	for (const [name, info] of found) {
		const current = currentByName[name];
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
		);
		if (status) {
			updates[name] = status;
		}
	}

	return updates;
}
