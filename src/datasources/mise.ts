import type { Dependency, UpdateRecord } from "../deps.ts";
import type { OutdatedOptions } from "../outdated.ts";
import { compare, parse } from "semver";
import {
	type Datasource,
	type DependencyRef,
	fetchOutdated,
	type VersionInfo,
} from "../datasource.ts";
import { semverVersioning } from "../versioning.ts";

/**
 * Where the per-tool version lists live. mise-versions publishes one
 * `docs/<tool>.toml` per registry short name (e.g. `node`, `aube`), each a
 * `[versions]` table mapping every released version to its `created_at`
 * timestamp. This is the mise analogue of npm's registry metadata: it is what
 * lets us apply the same minimum-release-age policy used for npm.
 *
 * @see https://github.com/jdx/mise-versions/tree/main/docs
 */
const MISE_VERSIONS_BASE =
	"https://raw.githubusercontent.com/jdx/mise-versions/main/docs";

/** A version line in a `docs/<tool>.toml`, e.g. `"1.18.0" = { created_at = … }`. */
const VERSION_LINE = /^"([^"]+)"\s*=\s*\{[^}]*\bcreated_at\s*=\s*([^,}\s]+)/;

/** The released versions of a mise tool and each one's publish timestamp. */
export interface VersionsMise {
	/** Every released version, in the order mise-versions lists them. */
	versions: string[];
	/** Maps each version to its ISO `created_at` timestamp. */
	times: Record<string, string | undefined>;
}

/**
 * Parse a mise-versions `docs/<tool>.toml` file into the versions and their
 * publish timestamps. Only the `[versions]` table is read; each entry looks like
 * `"1.18.0" = { created_at = 2026-06-04T17:42:42.000Z, release_url = "…" }`
 * (the `release_url` is optional — node, for instance, omits it).
 *
 * Hand-rolled to match the existing `parseMiseToml` in `../deps.ts` and to avoid
 * pulling in a TOML dependency for one well-known shape.
 */
export function parseVersionsTomlMise(content: string): VersionsMise {
	const versions: string[] = [];
	const times: Record<string, string | undefined> = {};
	let inVersions = false;

	for (const rawLine of content.split("\n")) {
		const line = rawLine.trim();
		if (line === "" || line.startsWith("#")) {
			continue;
		}
		if (line.startsWith("[")) {
			inVersions = line === "[versions]";
			continue;
		}
		if (!inVersions) {
			continue;
		}
		const match = VERSION_LINE.exec(line);
		if (!match) {
			continue;
		}
		const [, version, createdAt] = match;
		versions.push(version);
		times[version] = createdAt;
	}

	return { versions, times };
}

/**
 * The highest stable (non-prerelease) version, used as the synthetic `latest`
 * dist-tag mise-versions does not provide. Falls back to the highest version of
 * any kind when a tool has only prereleases. Returns `""` when nothing parses,
 * which simply disables the `respectLatest` guard for that tool.
 */
function latestStable(versions: string[]): string {
	let stable: string | null = null;
	let overall: string | null = null;
	for (const version of versions) {
		const parsed = parse(version);
		if (!parsed) {
			continue;
		}
		if (overall === null || compare(version, overall) > 0) {
			overall = version;
		}
		if (
			parsed.prerelease.length === 0 &&
			(stable === null || compare(version, stable) > 0)
		) {
			stable = version;
		}
	}
	return stable ?? overall ?? "";
}

/**
 * Fetch and parse the version list for a single mise tool, or `null` when the
 * tool has no `docs/<tool>.toml` (unknown tool, network error, etc.). `name` is
 * the mise registry short name produced by `normalizeMiseName` in `../deps.ts`.
 */
export async function fetchVersionsMise(
	name: string,
): Promise<VersionsMise | null> {
	try {
		const response = await fetch(
			`${MISE_VERSIONS_BASE}/${encodeURIComponent(name)}.toml`,
		);
		if (!response.ok) {
			return null;
		}
		return parseVersionsTomlMise(await response.text());
	} catch {
		return null;
	}
}

/**
 * The mise {@link Datasource}: looks up each tool's `docs/<tool>.toml` from
 * mise-versions, fanning out one request per tool. Synthesizes the `latest`
 * mise-versions does not provide as the highest stable version. Tools with no
 * docs toml (or no parseable versions) are omitted.
 */
export const datasourceMise: Datasource = {
	versioning: semverVersioning,
	async lookup(refs: DependencyRef[]): Promise<Map<string, VersionInfo>> {
		const results = await Promise.all(
			refs.map(async ({ name }) => ({
				name,
				data: await fetchVersionsMise(name),
			})),
		);

		const found = new Map<string, VersionInfo>();
		for (const { name, data } of results) {
			if (!data || data.versions.length === 0) {
				continue;
			}
			found.set(name, {
				versions: data.versions,
				times: data.times,
				latest: latestStable(data.versions),
			});
		}
		return found;
	},
};

/**
 * Look up mise-versions metadata for the given dependencies and return the
 * update each should receive, accounting for the minimum release age. Thin
 * ecosystem-named entry point over {@link fetchOutdated} and
 * {@link datasourceMise}; reuses the exact npm policy (`ignoreUnstable`,
 * `respectLatest`, held/safe states) sourced from `docs/<tool>.toml`.
 */
export function fetchOutdatedMise(
	dependencies: Dependency[],
	options: OutdatedOptions = {},
): Promise<UpdateRecord> {
	return fetchOutdated(dependencies, datasourceMise, options);
}
