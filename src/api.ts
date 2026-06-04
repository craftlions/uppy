import type { ContentReader } from "./deps.ts";
import {
	detectRenovateConfig,
	unknownRenovateConfigOptions,
} from "./renovate.ts";

/**
 * Build the HTTP response for the "get Renovate config" endpoint by locating the
 * repository's config and mapping the {@link detectRenovateConfig} result onto a
 * status code:
 *
 * - `200` with the located `{ path, config, unknownOptions }` as JSON when a
 *   config is found.
 * - `404` when the repository has no Renovate config at any known location.
 * - `422` when a config exists but cannot be parsed (the parse error is echoed).
 */
export async function configResponse(
	octokit: ContentReader,
	owner: string,
	repo: string,
): Promise<Response> {
	const result = await detectRenovateConfig(octokit, owner, repo);
	if (!result.ok) {
		return Response.json({ error: result.error.message }, { status: 422 });
	}
	if (result.data === null) {
		return Response.json(
			{ error: `No Renovate config found for ${owner}/${repo}` },
			{ status: 404 },
		);
	}
	return Response.json({
		...result.data,
		unknownOptions: unknownRenovateConfigOptions(result.data.config),
	});
}
