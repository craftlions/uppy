import { env } from "cloudflare:workers";
import { App } from "@octokit/app";
import { Octokit } from "@octokit/core";
import { restEndpointMethods } from "@octokit/plugin-rest-endpoint-methods";

let appInstance: ReturnType<typeof createApp> | undefined;

function createApp() {
	return new App({
		appId: env.GITHUB_APP_ID,
		privateKey: env.GITHUB_APP_PRIVATE_KEY,
		webhooks: {
			secret: env.GITHUB_APP_WEBHOOK_SECRET,
		},
		Octokit: Octokit.plugin(restEndpointMethods),
	});
}

/**
 * The shared GitHub App client, constructed lazily on first use. Lazy because
 * the Manager workflow modules pull this module into the detection import graph;
 * eager construction would require the app's private key just to read manifests
 * (or run a unit test).
 */
export function getApp(): ReturnType<typeof createApp> {
	if (!appInstance) {
		appInstance = createApp();
	}
	return appInstance;
}

export type GithubApp = ReturnType<typeof getApp>;

interface RepositoryAccess {
	defaultBranch: string;
	htmlUrl: string;
	installationId: number;
	octokit: Awaited<ReturnType<GithubApp["getInstallationOctokit"]>>;
}

/** Resolve installation-scoped repository access for the app's install. */
export async function repositoryAccessFor(
	owner: string,
	repo: string,
): Promise<RepositoryAccess> {
	const app = getApp();
	const { data: installation } =
		await app.octokit.rest.apps.getRepoInstallation({ owner, repo });
	const octokit = await app.getInstallationOctokit(installation.id);
	const { data: repository } = await octokit.rest.repos.get({ owner, repo });
	return {
		defaultBranch: repository.default_branch,
		htmlUrl: repository.html_url,
		installationId: installation.id,
		octokit,
	};
}
