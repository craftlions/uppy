import type { Dependency, ManagerDependencies, UpdateRecord } from "./deps.ts";
import type { Manager } from "./manager.ts";
import type { OutdatedOptions } from "./outdated.ts";
import { type Datasource, fetchOutdated } from "./datasource.ts";

/**
 * Resolve the {@link Datasource} adapter registered under a name, or `null` when
 * uppy has no adapter for it. Injected so the Update check can stay free of the
 * authenticated client a real {@link Datasource} needs and trivial to fake in
 * tests.
 */
export type DatasourceLookup = (name: string) => Datasource | null;

/**
 * Group a Manager's supported dependencies by the Datasource that resolves each.
 * Unsupported dependencies (shown for user awareness only) are dropped, and each
 * remaining dependency routes to its own {@link Dependency.datasource} when set
 * — mise's per-tool backend routing — or to the Manager's `defaultDatasource`.
 * A dependency that resolves to no datasource at all is skipped.
 */
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

/**
 * Run the Update check for one Manager's detected dependencies — the decision
 * pass between a Manager (files) and its Datasources (remote version metadata).
 * This is the highest seam that exercises routing, filtering, parallel lookup,
 * and merge without a full workflow.
 *
 * Given one {@link ManagerDependencies} group, the matching {@link Manager}, a
 * {@link DatasourceLookup} adapter, and {@link OutdatedOptions}, it:
 *
 * - flattens the Manager's detected files into a single dependency list,
 * - skips Unsupported dependencies so they never reach a Datasource,
 * - applies the Manager's default Datasource to dependencies without their own,
 * - honors per-dependency Datasource routing (mise backends),
 * - looks every Datasource up in parallel, skipping unknown adapter names,
 * - and merges the per-Datasource results into one {@link UpdateRecord} keyed by
 *   {@link import("./deps.ts").dependencyKey}.
 *
 * General recommendation policy (minimum release age, `ignoreUnstable`,
 * `respectLatest`) stays in this path via `options`; Datasources contribute only
 * version metadata and any narrow adapter-specific status composition.
 */
export async function fetchUpdateCheckForManager(
	managerDependencies: ManagerDependencies,
	manager: Manager,
	datasourceForName: DatasourceLookup,
	options: OutdatedOptions,
): Promise<UpdateRecord> {
	const dependencies = managerDependencies.files.flatMap(
		(file) => file.dependencies,
	);
	const updateEntries = await Promise.all(
		[...dependenciesByDatasource(dependencies, manager.datasource)].map(
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
