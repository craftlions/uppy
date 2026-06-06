import type { Datasource, DependencyRef, VersionInfo } from "../datasource.ts";
import { getVersionsBatch } from "fast-npm-meta";
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
		const keyByName = new Map(
			refs.map((ref) => [ref.name, ref.key ?? ref.name]),
		);
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
			found.set(keyByName.get(entry.name) ?? entry.name, {
				versions,
				times,
				latest,
			});
		}
		return found;
	},
};
