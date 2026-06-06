import type { Datasource } from "../datasource.ts";
import type { Dependency, UpdateRecord } from "../deps.ts";
import type { OutdatedOptions } from "../outdated.ts";
import { fetchOutdated } from "../datasource.ts";

type DatasourceLookup = (name: string) => Datasource | null;

function dependenciesByDatasource(
	dependencies: Dependency[],
	defaultDatasource?: string,
): Map<string, Dependency[]> {
	const groups = new Map<string, Dependency[]>();
	for (const dependency of dependencies) {
		if (dependency.unsupportedReason) {
			continue;
		}
		const datasource = dependency.datasource ?? defaultDatasource;
		if (!datasource) {
			continue;
		}
		const group = groups.get(datasource) ?? [];
		group.push(dependency);
		groups.set(datasource, group);
	}
	return groups;
}

export async function fetchUpdatesByDatasource(
	dependencies: Dependency[],
	defaultDatasource: string | undefined,
	datasourceForName: DatasourceLookup,
	options: OutdatedOptions,
): Promise<UpdateRecord> {
	const updateEntries = await Promise.all(
		[...dependenciesByDatasource(dependencies, defaultDatasource)].map(
			async ([datasourceName, datasourceDependencies]) => {
				const datasource = datasourceForName(datasourceName);
				if (!datasource) {
					return {};
				}
				return await fetchOutdated(datasourceDependencies, datasource, options);
			},
		),
	);
	return Object.assign({}, ...updateEntries);
}
