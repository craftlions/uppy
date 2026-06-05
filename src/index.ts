import { env, waitUntil } from "cloudflare:workers";
import { App } from "@octokit/app";
import { Octokit } from "@octokit/core";
import { restEndpointMethods } from "@octokit/plugin-rest-endpoint-methods";
import { createWebMiddleware } from "@octokit/webhooks";
import { configResponse } from "./api.ts";
import { detectDependencies, renderDependencies } from "./deps.ts";
import { fetchMiseOutdated } from "./mise.ts";
import {
	fetchOsvVulnerabilityAlerts,
	logOsvVulnerabilityAlerts,
	renderOsvVulnerabilityAlerts,
} from "./osv.ts";
import {
	effectiveMinimumReleaseAge,
	fetchOutdated,
	renderMinimumReleaseAgeNote,
} from "./outdated.ts";
import {
	dependencyDashboardEnabled,
	dependencyTypePinned,
	detectRenovateConfig,
	npmMinimumReleaseAgeMs,
	osvVulnerabilityAlertsEnabled,
	vulnerabilityAlertsEnabled,
} from "./renovate.ts";
import {
	fetchVulnerabilityAlerts,
	logVulnerabilityAlerts,
	renderVulnerabilityAlerts,
} from "./vulnerability-alerts.ts";

export { Sandbox } from "@cloudflare/sandbox";

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

/** Resolve an installation-scoped Octokit for the app's install on a repo. */
async function installationOctokitFor(owner: string, repo: string) {
	const { data: installation } =
		await app.octokit.rest.apps.getRepoInstallation({ owner, repo });
	return app.getInstallationOctokit(installation.id);
}

async function triggerUppyRun({
	organization,
	repository,
}: {
	organization: string;
	repository: string;
}) {
	const octokit = await installationOctokitFor(organization, repository);
	const configResult = await detectRenovateConfig(
		octokit,
		organization,
		repository,
	);
	const config =
		configResult.ok && configResult.data !== null
			? configResult.data.config
			: undefined;
	if (!(config && dependencyDashboardEnabled(config))) {
		return;
	}
	const issues = await octokit.rest.issues.listForRepo({
		owner: organization,
		repo: repository,
		state: "open",
		creator: "craftlions-uppy[bot]",
	});
	const ecosystems = await detectDependencies(
		octokit,
		organization,
		repository,
	);
	const npm = ecosystems.find((eco) => eco.ecosystem === "npm");
	const mise = ecosystems.find((eco) => eco.ecosystem === "mise");
	let vulnerabilityAlertsMarkdown = "";
	if (config && vulnerabilityAlertsEnabled(config)) {
		try {
			const alerts = await fetchVulnerabilityAlerts(
				octokit,
				organization,
				repository,
			);
			logVulnerabilityAlerts(alerts);
			vulnerabilityAlertsMarkdown = renderVulnerabilityAlerts(alerts);
		} catch {
			// best-effort: leave the alerts section empty on failure
		}
	}
	let osvAlertsMarkdown = "";
	if (npm && config && osvVulnerabilityAlertsEnabled(config)) {
		try {
			const alerts = await fetchOsvVulnerabilityAlerts(
				npm.files.flatMap((file) => file.dependencies),
			);
			logOsvVulnerabilityAlerts(alerts);
			osvAlertsMarkdown = renderOsvVulnerabilityAlerts(alerts);
		} catch {
			// best-effort: leave the OSV section empty on failure
		}
	}
	const minimumReleaseAge = effectiveMinimumReleaseAge(
		npmMinimumReleaseAgeMs(config),
	);
	const [npmUpdates, miseUpdates] = await Promise.all([
		npm
			? fetchOutdated(
					npm.files.flatMap((file) => file.dependencies),
					{ minimumReleaseAgeMs: minimumReleaseAge.ms },
				)
			: undefined,
		mise
			? fetchMiseOutdated(
					mise.files.flatMap((file) => file.dependencies),
					{ minimumReleaseAgeMs: minimumReleaseAge.ms },
				)
			: undefined,
	]);
	const updates =
		npmUpdates || miseUpdates
			? new Map([...(npmUpdates ?? []), ...(miseUpdates ?? [])])
			: undefined;
	const pins = new Set<string>();
	for (const dep of npm?.files.flatMap((file) => file.dependencies) ?? []) {
		if (
			dep.pinned === false &&
			dep.depType !== undefined &&
			dependencyTypePinned(config, dep.depType)
		) {
			pins.add(dep.name);
		}
	}
	const detected = renderDependencies(ecosystems, updates, pins);
	const dashboardMarkdown = `This issue lists Uppy updates and detected dependencies.\n\nLast updated at ${new Date().toISOString()}${
		detected ? `\n\n${detected}` : ""
	}`;
	const minimumReleaseAgeNote =
		(npm || mise) && minimumReleaseAge.forced
			? renderMinimumReleaseAgeNote()
			: "";
	const topSections = [
		minimumReleaseAgeNote,
		vulnerabilityAlertsMarkdown,
		osvAlertsMarkdown,
	].filter(Boolean);
	const body =
		topSections.length > 0
			? `${topSections.join("\n\n")}\n\n${dashboardMarkdown}`
			: dashboardMarkdown;

	if (issues.data.length > 0) {
		await octokit.rest.issues.update({
			owner: organization,
			repo: repository,
			issue_number: issues.data[0].number,
			body,
		});
	} else {
		await octokit.rest.issues.create({
			owner: organization,
			repo: repository,
			title: "Uppy Dashboard",
			body,
		});
	}
}

const middleware = createWebMiddleware(app.webhooks);

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
				const octokit = await installationOctokitFor(organization, repository);
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
			const body = await request.json();
			waitUntil(
				triggerUppyRun({
					organization: body.organization,
					repository: body.repository,
				}),
			);

			return new Response("OK", { status: 200 });
		}

		return new Response("Not Found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;
