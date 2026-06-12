import { env } from "cloudflare:workers";
import handler from "@astrojs/cloudflare/entrypoints/server";
import { createWebMiddleware } from "@octokit/webhooks";
import { configResponse } from "./api.ts";
import { getApp, repositoryAccessFor } from "./github.ts";
import { workflowInstanceId } from "./ids.ts";

const app = getApp();

app.webhooks.on("push", async ({ id, name }) => {
	console.log(`Received event ${name} with id ${id}`);
});

app.webhooks.on("pull_request.closed", async ({ id, name }) => {
	console.log(`Received event ${name} with id ${id}`);
});

const middleware = createWebMiddleware(app.webhooks);

type RunRequestBody = {
	organization: string;
	repository: string;
};

function isRunRequestBody(value: unknown): value is RunRequestBody {
	return (
		typeof value === "object" &&
		value !== null &&
		"organization" in value &&
		"repository" in value &&
		typeof value.organization === "string" &&
		typeof value.repository === "string" &&
		value.organization.length > 0 &&
		value.repository.length > 0
	);
}

export { GithubActionsWorkflow } from "./managers/github-actions.ts";
export { MiseWorkflow } from "./managers/mise.ts";
export { NpmWorkflow } from "./managers/npm.ts";
export { UppyWorkflow } from "./workflows/uppy.ts";

export default {
	async fetch(request, env, ctx) {
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
			const body = await request.json().catch(() => null);
			if (!isRunRequestBody(body)) {
				return Response.json(
					{
						error: "Expected JSON body with 'organization' and 'repository'",
					},
					{ status: 400 },
				);
			}
			console.log(
				`Creating uppy run for ${body.organization}/${body.repository}`,
			);
			await env.UPPY_WORKFLOW.create({
				id: workflowInstanceId(body.organization, body.repository),
				params: {
					organization: body.organization,
					repository: body.repository,
				},
			});

			return new Response("Created", { status: 201 });
		}
		return handler.fetch(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
