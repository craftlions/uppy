import type { Datasource, DependencyRef, VersionInfo } from "../datasource.ts";
import type { UpdateStatus } from "../deps.ts";
import { githubVersioning } from "../versioning.ts";

/** A full 40-hex commit sha — the only ref shape uppy treats as digest-pinned. */
const SHA = /^[0-9a-f]{40}$/i;

/**
 * A GraphQL client, satisfied by an installation-scoped Octokit's `graphql`
 * method. github-tags needs an authenticated client because it reads arbitrary
 * external repositories (`actions/checkout` etc.); the unauthenticated GitHub API
 * is rate-limited to 60 requests/hour.
 */
export interface GraphqlClient {
	graphql<T = unknown>(
		query: string,
		variables?: Record<string, unknown>,
	): Promise<T>;
}

/**
 * One batched query per repository: every tag (newest 100 by commit date) with
 * the commit it resolves to — peeling annotated tags to their target commit — plus
 * the repository's releases for their published timestamps. This is the single
 * round-trip the github-tags datasource makes per action.
 */
const TAGS_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    refs(refPrefix: "refs/tags/", first: 100, orderBy: { field: TAG_COMMIT_DATE, direction: DESC }) {
      nodes {
        name
        target {
          __typename
          ... on Commit { oid committedDate }
          ... on Tag { target { __typename ... on Commit { oid committedDate } } }
        }
      }
    }
    releases(first: 100) {
      nodes { tagName publishedAt }
    }
  }
}`;

interface CommitTarget {
	__typename: "Commit";
	oid: string;
	committedDate: string;
}

interface AnnotatedTagTarget {
	__typename: "Tag";
	target?: { __typename?: string; oid?: string; committedDate?: string };
}

interface TagNode {
	name: string;
	target: CommitTarget | AnnotatedTagTarget | null;
}

interface TagsResponse {
	repository: {
		refs: { nodes: TagNode[] };
		releases: { nodes: { tagName: string; publishedAt: string | null }[] };
	} | null;
}

/** Peel a tag's target to the commit it points to (annotated tags wrap a commit). */
function peelCommit(
	target: TagNode["target"],
): { oid: string; committedDate: string } | null {
	if (!target) {
		return null;
	}
	if (target.__typename === "Commit") {
		return { oid: target.oid, committedDate: target.committedDate };
	}
	const inner = target.target;
	if (inner?.__typename === "Commit" && inner.oid && inner.committedDate) {
		return { oid: inner.oid, committedDate: inner.committedDate };
	}
	return null;
}

/** The highest stable concrete tag, falling back to the highest tag of any kind. */
function latestStableTag(versions: string[]): string {
	let stable = "";
	let overall = "";
	for (const version of versions) {
		if (!githubVersioning.isValid(version)) {
			continue;
		}
		if (overall === "" || githubVersioning.compare(version, overall) > 0) {
			overall = version;
		}
		if (
			githubVersioning.isStable(version) &&
			(stable === "" || githubVersioning.compare(version, stable) > 0)
		) {
			stable = version;
		}
	}
	return stable || overall;
}

/**
 * Resolve the manifest ref to a current version and digest. The sha is ground
 * truth: a pinned sha is reverse-resolved to the most specific tag pointing at it
 * (the comment is never consulted). A floating tag is its own version with no
 * current digest. A ref we cannot resolve (an unknown sha, a branch) yields an
 * empty version, which leaves the action with no recommendation.
 */
function resolveCurrent(
	ref: string,
	versionsBySha: Map<string, string[]>,
): { currentVersion: string; currentDigest?: string } {
	if (SHA.test(ref)) {
		const sha = ref.toLowerCase();
		const matches = versionsBySha.get(sha) ?? [];
		let best = "";
		for (const candidate of matches) {
			if (!githubVersioning.isValid(candidate)) {
				continue;
			}
			best = pickMoreSpecific(best, candidate);
		}
		return { currentVersion: best, currentDigest: sha };
	}
	return { currentVersion: ref };
}

/** Prefer the higher version, breaking ties toward the more specific (longer) tag. */
function pickMoreSpecific(current: string, candidate: string): string {
	if (current === "") {
		return candidate;
	}
	const order = githubVersioning.compare(candidate, current);
	if (order > 0) {
		return candidate;
	}
	if (order === 0 && candidate.length > current.length) {
		return candidate;
	}
	return current;
}

/** Turn one repository's tag/release data into a {@link VersionInfo} for a ref. */
function buildVersionInfo(data: TagsResponse, ref: string): VersionInfo | null {
	const repository = data.repository;
	if (!repository) {
		return null;
	}

	const releasePublishedAt = new Map<string, string>();
	for (const release of repository.releases.nodes) {
		if (release.publishedAt) {
			releasePublishedAt.set(release.tagName, release.publishedAt);
		}
	}

	const times: Record<string, string | undefined> = {};
	const digests: Record<string, string | undefined> = {};
	const versionsBySha = new Map<string, string[]>();
	// Candidate versions include coarse tracks (`v4`, `v4.1`) as well as concrete
	// tags, so a repo that only publishes moving major tags still surfaces a
	// `v4` → `v5` upgrade rather than only a digest pin. `digests`/`times` are
	// keyed by every tag so any current ref (concrete or coarse) can be resolved.
	const versions: string[] = [];

	for (const node of repository.refs.nodes) {
		const commit = peelCommit(node.target);
		if (!commit) {
			continue;
		}
		const sha = commit.oid.toLowerCase();
		digests[node.name] = sha;
		times[node.name] =
			releasePublishedAt.get(node.name) ?? commit.committedDate;
		const forSha = versionsBySha.get(sha) ?? [];
		forSha.push(node.name);
		versionsBySha.set(sha, forSha);
		if (githubVersioning.isValid(node.name)) {
			versions.push(node.name);
		}
	}

	const { currentVersion, currentDigest } = resolveCurrent(ref, versionsBySha);

	return {
		versions,
		times,
		latest: latestStableTag(versions),
		currentVersion,
		currentDigest,
		digests,
	};
}

/** Fetch one repository's tags + releases, or null on any error (paranoid skip). */
async function fetchRepoTags(
	client: GraphqlClient,
	owner: string,
	name: string,
): Promise<TagsResponse | null> {
	try {
		return await client.graphql<TagsResponse>(TAGS_QUERY, { owner, name });
	} catch {
		return null;
	}
}

/**
 * Layer the digest-pin dimension onto a version-only update status (ADR-0003).
 *
 * The sha is ground truth and the recommendation is always "pin to the sha of the
 * safest acceptable version": the resolved `target` when an aged update exists,
 * otherwise the current version — pinning the current version is never age-gated,
 * only advancing to a newer tag is. A dependency that is up to date *and* already
 * pinned to that sha is omitted; one that floats on a tag, or is pinned to a stale
 * sha, surfaces a `digest` recommendation even with no version change.
 */
function composeDigestStatus(
	info: VersionInfo,
	current: string,
	status: UpdateStatus | null,
): UpdateStatus | null {
	const pinVersion = status?.target ?? current;
	const targetDigest = info.digests?.[pinVersion] ?? info.currentDigest;
	const currentDigest = info.currentDigest;

	if (status) {
		return { ...status, currentDigest, targetDigest };
	}
	if (targetDigest !== undefined && currentDigest !== targetDigest) {
		return {
			current,
			target: current,
			updateType: "digest",
			state: "safe",
			currentDigest,
			targetDigest,
		};
	}
	return null;
}

/**
 * The github-tags {@link Datasource}: for each `owner/repo` action it batches one
 * GraphQL query for the repository's tags (with the commit each resolves to) and
 * releases, then resolves the manifest ref to a current version/digest and a map
 * of version → sha. Speaks {@link githubVersioning} so coarse tags (`v4`) read as
 * tracks. Built per request because it needs an authenticated client.
 */
export function createGithubTagsDatasource(client: GraphqlClient): Datasource {
	return {
		versioning: githubVersioning,
		async lookup(refs: DependencyRef[]): Promise<Map<string, VersionInfo>> {
			// One network round-trip per repository even when several refs (e.g.
			// actions/checkout@v3 and @v4) point at the same `owner/repo`.
			const repoData = new Map<string, Promise<TagsResponse | null>>();
			const fetchRepo = (owner: string, name: string) => {
				const repo = `${owner}/${name}`;
				const cached = repoData.get(repo);
				if (cached) {
					return cached;
				}
				const pending = fetchRepoTags(client, owner, name);
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
						info: buildVersionInfo(data, ref.ref),
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
		composeStatus: composeDigestStatus,
	};
}
