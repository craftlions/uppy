import type { Manager } from "../manager.ts";
import {
	type DependencyFile,
	fetchFileContent,
	parsePackageJson,
} from "../deps.ts";

const PACKAGE_JSON = "package.json";

/**
 * The npm {@link Manager}: reads `package.json` and parses its `dependencies` and
 * `devDependencies`. Resolved through the like-named `npm` datasource.
 */
export const npmManager: Manager = {
	name: "npm",
	datasource: "npm",
	async detect(octokit, owner, repo): Promise<DependencyFile[]> {
		const content = await fetchFileContent(octokit, owner, repo, PACKAGE_JSON);
		if (!content) {
			return [];
		}
		const dependencies = parsePackageJson(content);
		return dependencies.length > 0
			? [{ file: PACKAGE_JSON, dependencies }]
			: [];
	},
};
