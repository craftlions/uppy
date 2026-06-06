import type { Dependency, UpdateRecord } from "../deps.ts";
import type { OutdatedOptions } from "../outdated.ts";
import { parse as parseYaml } from "yaml";
import {
	type Datasource,
	type DependencyRef,
	fetchOutdated,
	type VersionInfo,
} from "../datasource.ts";
import { semverVersioning } from "../versioning.ts";
import { createGithubReleasesDatasource } from "./github-releases.ts";
import {
	createGithubTagsDatasource,
	type GraphqlClient,
} from "./github-tags.ts";
import { datasourceNpm } from "./npm.ts";

const AQUA_REGISTRY_BASE =
	"https://raw.githubusercontent.com/aquaproj/aqua-registry/main/pkgs";

const AQUA_TAG_PACKAGES = new Set([
	"golang/go",
	"golang/tools",
	"kubernetes/kubectl",
	"twistedpair/google-cloud-sdk",
	"awslabs/mountpoint-s3",
	"aws/aws-cli",
	"catenacyber/perfsprint",
	"golang/vuln/govulncheck",
	"anthropics/claude-code",
	"apache/ant",
	"getdbt.com/dbt-fusion",
]);

const AQUA_NPM_PACKAGES: Record<string, string> = {
	"trunk-io/launcher": "@trunkio/launcher",
};

interface AquaRegistryPackage {
	name?: string;
	type?: string;
	repo_owner?: string;
	repo_name?: string;
	version_prefix?: string;
	version_source?: string;
}

interface AquaRegistry {
	packages?: AquaRegistryPackage[];
}

interface AquaResolution {
	datasource: "github-releases" | "github-tags" | "npm";
	name: string;
	versionPrefix?: string;
}

function stripVersionPrefix(info: VersionInfo, prefix: string): VersionInfo {
	const versions = info.versions
		.filter((version) => version.startsWith(prefix))
		.map((version) => version.slice(prefix.length));
	const times: Record<string, string | undefined> = {};
	for (const version of versions) {
		times[version] = info.times[`${prefix}${version}`];
	}
	let latest = "";
	for (const version of versions) {
		if (
			semverVersioning.isStable(version) &&
			(latest === "" || semverVersioning.compare(version, latest) > 0)
		) {
			latest = version;
		}
	}
	return { versions, times, latest };
}

function withoutDigests(info: VersionInfo): VersionInfo {
	return {
		versions: info.versions,
		times: info.times,
		latest: info.latest,
		currentVersion: info.currentVersion,
	};
}

async function fetchAquaRegistryPackage(
	name: string,
): Promise<AquaRegistryPackage | null> {
	try {
		const response = await fetch(`${AQUA_REGISTRY_BASE}/${name}/registry.yaml`);
		if (!response.ok) {
			return null;
		}
		const registry = parseYaml(await response.text()) as AquaRegistry;
		return registry.packages?.[0] ?? null;
	} catch {
		return null;
	}
}

async function resolveAquaPackage(
	name: string,
): Promise<AquaResolution | null> {
	const npmName = AQUA_NPM_PACKAGES[name];
	if (npmName) {
		return { datasource: "npm", name: npmName };
	}

	const registryPackage = await fetchAquaRegistryPackage(name);
	const repoOwner = registryPackage?.repo_owner;
	const repoName = registryPackage?.repo_name;
	if (!repoOwner || !repoName) {
		return null;
	}

	const datasource =
		registryPackage.version_source === "github_tag" ||
		AQUA_TAG_PACKAGES.has(name)
			? "github-tags"
			: "github-releases";

	return {
		datasource,
		name: `${repoOwner}/${repoName}`,
		versionPrefix: registryPackage.version_prefix,
	};
}

export function createAquaDatasource(client: GraphqlClient): Datasource {
	const githubReleases = createGithubReleasesDatasource(client);
	const githubTags = createGithubTagsDatasource(client);
	return {
		versioning: semverVersioning,
		async lookup(refs: DependencyRef[]): Promise<Map<string, VersionInfo>> {
			const resolutions = await Promise.all(
				refs.map(async (ref) => ({
					ref,
					resolution: await resolveAquaPackage(ref.name),
				})),
			);

			const found = new Map<string, VersionInfo>();
			for (const datasource of [
				"github-releases",
				"github-tags",
				"npm",
			] as const) {
				const routed = resolutions.filter(
					(entry) => entry.resolution?.datasource === datasource,
				);
				if (routed.length === 0) {
					continue;
				}
				const lookupRefs = routed.map(({ ref, resolution }) => ({
					name: resolution?.name ?? ref.name,
					ref: ref.ref,
					key: ref.key ?? ref.name,
				}));
				const datasourceFound =
					datasource === "github-releases"
						? await githubReleases.lookup(lookupRefs)
						: datasource === "github-tags"
							? await githubTags.lookup(lookupRefs)
							: await datasourceNpm.lookup(lookupRefs);

				for (const { ref, resolution } of routed) {
					const key = ref.key ?? ref.name;
					const info = datasourceFound.get(key);
					if (!info) {
						continue;
					}
					found.set(
						key,
						withoutDigests(
							resolution?.versionPrefix
								? stripVersionPrefix(info, resolution.versionPrefix)
								: info,
						),
					);
				}
			}
			return found;
		},
	};
}

export function fetchOutdatedAqua(
	dependencies: Dependency[],
	client: GraphqlClient,
	options: OutdatedOptions = {},
): Promise<UpdateRecord> {
	return fetchOutdated(dependencies, createAquaDatasource(client), options);
}
