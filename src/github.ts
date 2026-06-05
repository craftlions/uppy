import { env } from "cloudflare:workers";
import { App } from "@octokit/app";
import { Octokit } from "@octokit/core";
import { restEndpointMethods } from "@octokit/plugin-rest-endpoint-methods";

export const app = new App({
	appId: env.GITHUB_APP_ID,
	privateKey: env.GITHUB_APP_PRIVATE_KEY,
	webhooks: {
		secret: env.GITHUB_APP_WEBHOOK_SECRET,
	},
	Octokit: Octokit.plugin(restEndpointMethods),
});

interface RepositoryAccess {
	defaultBranch: string;
	htmlUrl: string;
	installationId: number;
	octokit: Awaited<ReturnType<typeof app.getInstallationOctokit>>;
}

/** Resolve installation-scoped repository access for the app's install. */
export async function repositoryAccessFor(
	owner: string,
	repo: string,
): Promise<RepositoryAccess> {
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
