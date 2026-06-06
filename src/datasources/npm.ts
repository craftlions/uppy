import type { Dependency, UpdateRecord } from "../deps.ts";
import type { OutdatedOptions } from "../outdated.ts";
import { getVersionsBatch } from "fast-npm-meta";
import {
	type Datasource,
	type DependencyRef,
	fetchOutdated,
	type VersionInfo,
} from "../datasource.ts";
import { semverVersioning } from "../versioning.ts";

/** The npm.antfu.dev endpoint caps each batch lookup; chunk requests to match. */
const BATCH_SIZE = 50;

/**
 * The npm {@link Datasource}: looks up registry metadata (including per-version
 * publish times and the `latest` dist-tag) through fast-npm-meta, chunking names
 * to respect the endpoint's batch cap. Entries without a `latest` dist-tag are
 * omitted.
 */
export const datasourceNpm: Datasource = {
	versioning: semverVersioning,
	async lookup(refs: DependencyRef[]): Promise<Map<string, VersionInfo>> {
		const names = refs.map((ref) => ref.name);
		const chunks: string[][] = [];
		for (let i = 0; i < names.length; i += BATCH_SIZE) {
			chunks.push(names.slice(i, i + BATCH_SIZE));
		}

		const batches = await Promise.all(
			chunks.map((chunk) => getVersionsBatch(chunk, { metadata: true })),
		);

		const found = new Map<string, VersionInfo>();
		for (const entry of batches.flat()) {
			const latest = entry.distTags?.latest;
			if (!latest) {
				continue;
			}
			const versionsMeta = entry.versionsMeta ?? {};
			const versions = Object.keys(versionsMeta);
			const times: Record<string, string | undefined> = {};
			for (const [version, meta] of Object.entries(versionsMeta)) {
				times[version] = meta?.time;
			}
			found.set(entry.name, { versions, times, latest });
		}
		return found;
	},
};

/**
 * Look up the npm registry metadata for the given dependencies and return the
 * update each should receive, accounting for the minimum release age. Thin
 * ecosystem-named entry point over {@link fetchOutdated} and {@link datasourceNpm}.
 */
export function fetchOutdatedNpm(
	dependencies: Dependency[],
	options: OutdatedOptions = {},
): Promise<UpdateRecord> {
	return fetchOutdated(dependencies, datasourceNpm, options);
}
