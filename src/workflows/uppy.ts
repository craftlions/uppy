import type { WorkflowEvent } from "cloudflare:workers";
import { WorkflowEntrypoint, type WorkflowStep } from "cloudflare:workers";
import {
	detectDependencies,
	listSafeUpgrades,
	renderDependencies,
} from "../deps.ts";
import { repositoryAccessFor } from "../github.ts";
import { nanoid } from "../ids.ts";
import { fetchMiseOutdated } from "../mise.ts";
import {
	fetchOsvVulnerabilityAlerts,
	logOsvVulnerabilityAlerts,
	type OsvVulnerabilityAlert,
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
	type DependabotAlert,
	fetchVulnerabilityAlerts,
	logVulnerabilityAlerts,
	renderVulnerabilityAlerts,
} from "../vulnerability-alerts.ts";

type Params = { organization: string; repository: string };

export class UppyWorkflow extends WorkflowEntrypoint<Env, Params> {
	async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
		const { organization, repository } = event.payload;

		const detectedConfig = await step.do("detect Renovate config", async () => {
			const { octokit } = await repositoryAccessFor(organization, repository);
			const result = await detectRenovateConfig(
				octokit,
				organization,
				repository,
			);
			if (!result.ok) {
				throw result.error;
			}
			return result.data;
		});

		const config = detectedConfig?.config;

		const ecosystems = await step.do("detect dependencies", async () => {
			const { octokit } = await repositoryAccessFor(organization, repository);
			return await detectDependencies(octokit, organization, repository);
		});

		let vulnerabilityAlerts: DependabotAlert[] = [];
		if (config && vulnerabilityAlertsEnabled(config)) {
			vulnerabilityAlerts = await step.do(
				"fetch GitHub vulnerability alerts",
				async () => {
					const { octokit } = await repositoryAccessFor(
						organization,
						repository,
					);
					try {
						const alerts = await fetchVulnerabilityAlerts(
							octokit,
							organization,
							repository,
						);
						logVulnerabilityAlerts(alerts);
						return alerts;
					} catch (cause) {
						console.warn(
							`Failed to fetch GitHub vulnerability alerts for ${organization}/${repository}:`,
							cause,
						);
						return [];
					}
				},
			);
		}

		let osvAlerts: OsvVulnerabilityAlert[] = [];
		if (config && osvVulnerabilityAlertsEnabled(config)) {
			osvAlerts = await step.do(
				"query OSV for npm vulnerabilities",
				async () => {
					const npmEcosystem = ecosystems.find(
						(eco) => eco.ecosystem === "npm",
					);
					const dependencies =
						npmEcosystem?.files.flatMap((file) => file.dependencies) ?? [];
					try {
						const alerts = await fetchOsvVulnerabilityAlerts(dependencies);
						logOsvVulnerabilityAlerts(alerts);
						return alerts;
					} catch (cause) {
						console.warn(
							`Failed to query OSV for ${organization}/${repository}:`,
							cause,
						);
						return [];
					}
				},
			);
		}

		const minimumReleaseAge = effectiveMinimumReleaseAge(
			npmMinimumReleaseAgeMs(config ?? {}),
		);

		const updates = await Promise.all([
			step.do("fetch outdated npm dependencies", async () => {
				const npmEcosystem = ecosystems.find((eco) => eco.ecosystem === "npm");
				return await fetchOutdated(
					npmEcosystem?.files.flatMap((file) => file.dependencies) ?? [],
					{ minimumReleaseAgeMs: minimumReleaseAge.ms },
				);
			}),
			step.do("fetch outdated mise dependencies", async () => {
				const miseEcosystem = ecosystems.find(
					(eco) => eco.ecosystem === "mise",
				);
				return await fetchMiseOutdated(
					miseEcosystem?.files.flatMap((file) => file.dependencies) ?? [],
					{ minimumReleaseAgeMs: minimumReleaseAge.ms },
				);
			}),
		]);
		const updatesByEcosystem = { npm: updates[0], mise: updates[1] };

		const safeUpgrades = await step.do("list safe upgrades", async () => {
			return listSafeUpgrades(ecosystems, updatesByEcosystem);
		});

		let safeUpgradesDispatched = 0;
		if (safeUpgrades.length > 0) {
			safeUpgradesDispatched = await step.do(
				"dispatch safe upgrade workflows",
				async () => {
					const instances = await this.env.MISE_WORKFLOW.createBatch(
						safeUpgrades.map((upgrade) => {
							const slug = `${upgrade.ecosystem}-${upgrade.package.replaceAll("@", "").replaceAll("/", "-")}-${upgrade.target}`;
							return {
								id: `${event.instanceId}-mise-${nanoid()}`,
								params: { branch: `uppy/${slug}` },
							};
						}),
					);
					return instances.length;
				},
			);
		}

		if (config && dependencyDashboardEnabled(config)) {
			const dashboardMarkdown = await step.do(
				"render dashboard markdown",
				async () => {
					const vulnerabilityAlertsMarkdown =
						renderVulnerabilityAlerts(vulnerabilityAlerts);
					const osvAlertsMarkdown = renderOsvVulnerabilityAlerts(osvAlerts);
					const detected = renderDependencies(ecosystems, updatesByEcosystem);
					const header = `This issue lists Uppy updates and detected dependencies.\n\nLast updated at ${new Date().toISOString()}`;
					const body = detected ? `\n\n${detected}` : "";
					const prefix = [
						minimumReleaseAge.forced ? renderMinimumReleaseAgeNote() : "",
						vulnerabilityAlertsMarkdown,
						osvAlertsMarkdown,
					]
						.filter(Boolean)
						.join("\n\n");
					return prefix ? `${prefix}\n\n${header}${body}` : `${header}${body}`;
				},
			);

			await step.do("sync dependency dashboard issue", async () => {
				const { octokit } = await repositoryAccessFor(organization, repository);
				const issues = await octokit.rest.issues.listForRepo({
					owner: organization,
					repo: repository,
					state: "open",
					creator: "craftlions-uppy[bot]",
				});
				if (issues.data.length > 0) {
					await octokit.rest.issues.update({
						owner: organization,
						repo: repository,
						issue_number: issues.data[0].number,
						body: dashboardMarkdown,
					});
				} else {
					await octokit.rest.issues.create({
						owner: organization,
						repo: repository,
						title: "Uppy Dashboard",
						body: dashboardMarkdown,
					});
				}
			});
		}

		return {
			organization,
			repository,
			configPath: detectedConfig?.path ?? null,
			safeUpgradesDispatched,
		};
	}
}
