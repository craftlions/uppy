import type { Manager } from "../manager.ts";
import {
	type DependencyFile,
	fetchFileContent,
	parseMiseToml,
} from "../deps.ts";

const MISE_TOML = "mise.toml";

/**
 * The mise {@link Manager}: reads `mise.toml` and parses its `[tools]` table.
 * Resolved through the like-named `mise` datasource.
 */
export const miseManager: Manager = {
	name: "mise",
	datasource: "mise",
	async detect(octokit, owner, repo): Promise<DependencyFile[]> {
		const content = await fetchFileContent(octokit, owner, repo, MISE_TOML);
		if (!content) {
			return [];
		}
		const dependencies = parseMiseToml(content);
		return dependencies.length > 0 ? [{ file: MISE_TOML, dependencies }] : [];
	},
};
