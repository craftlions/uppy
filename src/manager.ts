import type { Datasource } from "./datasource.ts";
import type {
	ContentReader,
	DependencyEcosystem,
	DependencyFile,
} from "./deps.ts";
import { createAquaDatasource } from "./datasources/aqua.ts";
import { createGithubReleasesDatasource } from "./datasources/github-releases.ts";
import {
	createGithubTagsDatasource,
	type GraphqlClient,
} from "./datasources/github-tags.ts";
import { datasourceCore } from "./datasources/mise.ts";
import { datasourceNpm } from "./datasources/npm.ts";
import { githubActionsManager } from "./managers/github-actions.ts";
import { miseManager } from "./managers/mise.ts";
import { npmManager } from "./managers/npm.ts";

/**
 * The file-reading half of an update check (see CONTEXT.md): parses a family of
 * manifests and tags each dependency with the {@link Datasource} that resolves
 * it. Mirrors Renovate's manager vocabulary.
 */
export interface Manager {
	/** Renovate manager name; also the dashboard section and ecosystem label. */
	readonly name: string;
	/** The default datasource for dependencies without their own datasource. */
	readonly datasource?: string;
	/** Read and parse this manager's manifests from a repository. */
	detect(
		octokit: ContentReader,
		owner: string,
		repo: string,
	): Promise<DependencyFile[]>;
}

/** Every manager uppy runs, in dashboard order. */
export const MANAGERS: readonly Manager[] = [
	miseManager,
	npmManager,
	githubActionsManager,
];

/** The registered manager with this name, if any. */
export const managerByName = (name: string): Manager | undefined =>
	MANAGERS.find((manager) => manager.name === name);

/**
 * Read every manager's manifests from a repository and group the detected
 * dependencies by ecosystem (the manager name). Managers that find nothing are
 * omitted. The orchestrator over {@link MANAGERS}.
 */
export async function detectDependencies(
	octokit: ContentReader,
	owner: string,
	repo: string,
): Promise<DependencyEcosystem[]> {
	const ecosystems: DependencyEcosystem[] = [];
	for (const manager of MANAGERS) {
		const files = await manager.detect(octokit, owner, repo);
		const nonEmpty = files.filter((file) => file.dependencies.length > 0);
		if (nonEmpty.length > 0) {
			ecosystems.push({ ecosystem: manager.name, files: nonEmpty });
		}
	}
	return ecosystems;
}

/**
 * The {@link Datasource} registered under `name`, or null when unknown. The
 * `github-tags` datasource is built per call because it needs an authenticated
 * GraphQL client; npm and mise are shared singletons that ignore it.
 */
export function datasourceFor(
	name: string,
	client: GraphqlClient,
): Datasource | null {
	switch (name) {
		case "aqua":
			return createAquaDatasource(client);
		case "core":
			return datasourceCore;
		case "npm":
			return datasourceNpm;
		case "github-releases":
			return createGithubReleasesDatasource(client);
		case "github-tags":
			return createGithubTagsDatasource(client);
		default:
			return null;
	}
}
