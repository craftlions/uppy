import type { Datasource, DependencyRef, VersionInfo } from "../datasource.ts";
import type { GraphqlClient } from "./github-tags.ts";
import { semverVersioning } from "../versioning.ts";

const RELEASES_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    releases(first: 100, orderBy: { field: CREATED_AT, direction: DESC }) {
      nodes { tagName publishedAt isDraft }
    }
  }
}`;

interface ReleasesResponse {
	repository: {
		releases: {
			nodes: {
				tagName: string;
				publishedAt: string | null;
				isDraft: boolean;
			}[];
		};
	} | null;
}

function latestStableRelease(versions: string[]): string {
	let stable = "";
	let overall = "";
	for (const version of versions) {
		if (!semverVersioning.isValid(version)) {
			continue;
		}
		if (overall === "" || semverVersioning.compare(version, overall) > 0) {
			overall = version;
		}
		if (
			semverVersioning.isStable(version) &&
			(stable === "" || semverVersioning.compare(version, stable) > 0)
		) {
			stable = version;
		}
	}
	return stable || overall;
}

async function fetchRepoReleases(
	client: GraphqlClient,
	owner: string,
	name: string,
): Promise<ReleasesResponse | null> {
	try {
		return await client.graphql<ReleasesResponse>(RELEASES_QUERY, {
			owner,
			name,
		});
	} catch {
		return null;
	}
}

function buildVersionInfo(data: ReleasesResponse): VersionInfo | null {
	const repository = data.repository;
	if (!repository) {
		return null;
	}

	const versions: string[] = [];
	const times: Record<string, string | undefined> = {};
	for (const release of repository.releases.nodes) {
		if (release.isDraft) {
			continue;
		}
		versions.push(release.tagName);
		times[release.tagName] = release.publishedAt ?? undefined;
	}
	if (versions.length === 0) {
		return null;
	}
	return {
		versions,
		times,
		latest: latestStableRelease(versions),
	};
}

export function createGithubReleasesDatasource(
	client: GraphqlClient,
): Datasource {
	return {
		versioning: semverVersioning,
		async lookup(refs: DependencyRef[]): Promise<Map<string, VersionInfo>> {
			const repoData = new Map<string, Promise<ReleasesResponse | null>>();
			const fetchRepo = (owner: string, name: string) => {
				const repo = `${owner}/${name}`;
				const cached = repoData.get(repo);
				if (cached) {
					return cached;
				}
				const pending = fetchRepoReleases(client, owner, name);
				repoData.set(repo, pending);
				return pending;
			};

			const results = await Promise.all(
				refs.map(async (ref) => {
					const [owner, name] = ref.name.split("/");
					if (!owner || !name) {
						return null;
					}
					const data = await fetchRepo(owner, name);
					if (!data) {
						return null;
					}
					return {
						key: ref.key ?? ref.name,
						info: buildVersionInfo(data),
					};
				}),
			);

			const found = new Map<string, VersionInfo>();
			for (const result of results) {
				if (result?.info) {
					found.set(result.key, result.info);
				}
			}
			return found;
		},
	};
}
