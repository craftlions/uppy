import type { WorkflowEvent } from "cloudflare:workers";
import { WorkflowEntrypoint, type WorkflowStep } from "cloudflare:workers";
import {
	detectDependencies,
	listSafeUpgrades,
	renderDependencies,
} from "../deps.ts";
import { nanoid, repositoryAccessFor } from "../index.ts";
import { fetchMiseOutdated } from "../mise.ts";
import {
	fetchOsvVulnerabilityAlerts,
	logOsvVulnerabilityAlerts,
	renderOsvVulnerabilityAlerts,
} from "../osv.ts";
import {
	effectiveMinimumReleaseAge,
	fetchOutdated,
	renderMinimumReleaseAgeNote,
} from "../outdated.ts";
import {
	dependencyDashboardEnabled,
	detectRenovateConfig,
	npmMinimumReleaseAgeMs,
	osvVulnerabilityAlertsEnabled,
	vulnerabilityAlertsEnabled,
} from "../renovate.ts";
import {
	fetchVulnerabilityAlerts,
	logVulnerabilityAlerts,
	renderVulnerabilityAlerts,
} from "../vulnerability-alerts.ts";

type Params = { organization: string; repository: string };

export class UppyWorkflow extends WorkflowEntrypoint<Env, Params> {
	async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
		const access = await repositoryAccessFor(
			event.payload.organization,
			event.payload.repository,
		);
		const octokit = access.octokit;

		const config = await step.do("fetch config", async () => {
			const configResult = await detectRenovateConfig(
				octokit,
				event.payload.organization,
				event.payload.repository,
			);
			const config =
				configResult.ok && configResult.data !== null
					? configResult.data.config
					: undefined;
			return JSON.stringify(config, null, 2);
		});

		const ecosystems = await step.do("detect ecosystems", async () => {
			const ecosystems = await detectDependencies(
				octokit,
				event.payload.organization,
				event.payload.repository,
			);
			return JSON.stringify(ecosystems, null, 2);
		});

		let vulnerabilityAlerts = [];
		if (config && vulnerabilityAlertsEnabled(JSON.parse(config))) {
			vulnerabilityAlerts = await step.do(
				"vulnerability alerts enabled",
				async () => {
					try {
						const alerts = await fetchVulnerabilityAlerts(
							octokit,
							event.payload.organization,
							event.payload.repository,
						);
						logVulnerabilityAlerts(alerts);
						return alerts;
					} catch {
						return [];
					}
				},
			);
		}

		let osvAlerts = [];
		if (config && osvVulnerabilityAlertsEnabled(JSON.parse(config))) {
			osvAlerts = await Promise.all([
				step.do("osv npm", async () => {
					try {
						const alerts = await fetchOsvVulnerabilityAlerts(
							JSON.parse(ecosystems)
								.find((e) => e.ecosystem === "npm")
								.files.flatMap((file) => file.dependencies),
						);
						logOsvVulnerabilityAlerts(alerts);
						return alerts;
					} catch {
						return [];
					}
				}),
			]);
		}

		const minimumReleaseAge = effectiveMinimumReleaseAge(
			npmMinimumReleaseAgeMs(JSON.parse(config)),
		);

		const updates = await Promise.all([
			step.do("npm updates", async () => {
				return await fetchOutdated(
					JSON.parse(ecosystems)
						.find((e) => e.ecosystem === "npm")
						?.files.flatMap((file) => file.dependencies) || [],
					{ minimumReleaseAgeMs: minimumReleaseAge.ms },
				);
			}),
			step.do("mise updates", async () => {
				return await fetchMiseOutdated(
					JSON.parse(ecosystems)
						.find((e) => e.ecosystem === "mise")
						?.files.flatMap((file) => file.dependencies) || [],
					{
						minimumReleaseAgeMs: minimumReleaseAge.ms,
					},
				);
			}),
		]);

		const finalMarkdown = await step.do("generate markdown", async () => {
			const vulnerabilityAlertsMarkdown =
				renderVulnerabilityAlerts(vulnerabilityAlerts);
			const osvAlertsMarkdown = renderOsvVulnerabilityAlerts(osvAlerts.flat());
			const detected = await renderDependencies(
				JSON.parse(ecosystems),
				updates,
			);
			const dashboardMarkdown = `This issue lists Uppy updates and detected dependencies.\n\nLast updated at ${new Date().toISOString()}${
				detected ? `\n\n${detected}` : ""
			}`;
			const minimumReleaseAgeNote = minimumReleaseAge.forced
				? renderMinimumReleaseAgeNote()
				: "";
			const topSections = [
				minimumReleaseAgeNote,
				vulnerabilityAlertsMarkdown,
				osvAlertsMarkdown,
			].filter(Boolean);
			return topSections.length > 0
				? `${topSections.join("\n\n")}\n\n${dashboardMarkdown}`
				: dashboardMarkdown;
		});

		if (config && dependencyDashboardEnabled(JSON.parse(config))) {
			await step.do("dependency dashboard enabled", async () => {
				const issues = await octokit.rest.issues.listForRepo({
					owner: event.payload.organization,
					repo: event.payload.repository,
					state: "open",
					creator: "craftlions-uppy[bot]",
				});
				if (issues.data.length > 0) {
					await octokit.rest.issues.update({
						owner: event.payload.organization,
						repo: event.payload.repository,
						issue_number: issues.data[0].number,
						body: finalMarkdown,
					});
				} else {
					await octokit.rest.issues.create({
						owner: event.payload.organization,
						repo: event.payload.repository,
						title: "Uppy Dashboard",
						body: finalMarkdown,
					});
				}
			});
		}

		await step.do("safe upgrades", async () => {
			const safeUpgrades = listSafeUpgrades(JSON.parse(ecosystems), updates[0]);
			for (const safeUpgrade of safeUpgrades) {
				await this.env.MISE_WORKFLOW.create({
					id: `${event.instanceId}-mise-${nanoid()}`,
					params: {
						branch: `uppy/${safeUpgrade.ecosystem}-${safeUpgrade.package.replaceAll("@", "").replaceAll("/", "-")}-${safeUpgrade.target}`,
					},
				});
			}
		});
	}
}
