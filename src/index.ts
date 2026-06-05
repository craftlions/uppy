import { env } from "cloudflare:workers";
import { App } from "@octokit/app";
import { Octokit } from "@octokit/core";
import { restEndpointMethods } from "@octokit/plugin-rest-endpoint-methods";
import { createWebMiddleware } from "@octokit/webhooks";
import { customAlphabet } from "nanoid";
import { configResponse } from "./api.ts";

const app = new App({
	appId: env.GITHUB_APP_ID,
	privateKey: env.GITHUB_APP_PRIVATE_KEY,
	webhooks: {
		secret: env.GITHUB_APP_WEBHOOK_SECRET,
	},
	Octokit: Octokit.plugin(restEndpointMethods),
});

app.webhooks.on("push", async ({ id, name }) => {
	console.log(`Received event ${name} with id ${id}`);
});

app.webhooks.on("pull_request.closed", async ({ id, name }) => {
	console.log(`Received event ${name} with id ${id}`);
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

export const nanoid = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 6);

const middleware = createWebMiddleware(app.webhooks);

export { MiseWorkflow } from "./workflows/mise.ts";
export { UppyWorkflow } from "./workflows/uppy.ts";

export default {
	async fetch(request) {
		const url = new URL(request.url);

		if (url.pathname === "/api/github/webhooks") {
			return middleware(request);
		}
		if (request.method === "GET" && url.pathname === "/config") {
			const organization = url.searchParams.get("organization");
			const repository = url.searchParams.get("repository");
			if (!(organization && repository)) {
				return Response.json(
					{
						error: "Missing 'organization' or 'repository' query parameter",
					},
					{ status: 400 },
				);
			}
			try {
				const { octokit } = await repositoryAccessFor(organization, repository);
				return await configResponse(octokit, organization, repository);
			} catch (cause) {
				const message = cause instanceof Error ? cause.message : String(cause);
				return Response.json(
					{
						error: `Failed to access ${organization}/${repository}: ${message}`,
					},
					{ status: 502 },
				);
			}
		}
		if (request.method === "POST" && url.pathname === "/runs") {
			const body = await request.json(); // TODO add zod v4 safeParseAsync validation
			await env.UPPY_WORKFLOW.create({
				id: `${body.organization}-${body.repository}-${nanoid()}`,
				params: {
					organization: body.organization,
					repository: body.repository,
				},
			});

			return new Response("Created", { status: 201 });
		}

		return new Response("Not Found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;
