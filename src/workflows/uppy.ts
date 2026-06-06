import type { WorkflowEvent } from "cloudflare:workers";
import { WorkflowEntrypoint, type WorkflowStep } from "cloudflare:workers";
import { fetchOutdated } from "../datasource.ts";
import {
	type PinAction,
	renderDependencyDashboard,
} from "../dependency-dashboard.ts";
import { listSafeUpgrades, type UpdateRecord } from "../deps.ts";
import { repositoryAccessFor } from "../github.ts";
import { nanoid } from "../ids.ts";
import {
	datasourceFor,
	detectDependencies,
	managerByName,
} from "../manager.ts";
import {
	fetchOsvVulnerabilityAlerts,
	logOsvVulnerabilityAlerts,
	type OsvVulnerabilityAlert,
} from "../osv.ts";
import { effectiveMinimumReleaseAge } from "../outdated.ts";
import {
	dependencyDashboardEnabled,
	dependencyTypePinned,
	detectRenovateConfig,
	npmMinimumReleaseAgeMs,
	osvVulnerabilityAlertsEnabled,
	vulnerabilityAlertsEnabled,
} from "../renovate.ts";
import {
	type DependabotAlert,
	fetchVulnerabilityAlerts,
	logVulnerabilityAlerts,
} from "../vulnerability-alerts.ts";

type Params = { organization: string; repository: string };

export class UppyWorkflow extends WorkflowEntrypoint<Env, Params> {
	async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
		const { organization, repository } = event.payload;

		const detectedConfig = await step.do("detect-renovate-config", async () => {
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

		const ecosystems = await step.do("detect-dependencies", async () => {
			const { octokit } = await repositoryAccessFor(organization, repository);
			return await detectDependencies(octokit, organization, repository);
		});

		let vulnerabilityAlerts: DependabotAlert[] = [];
		if (config && vulnerabilityAlertsEnabled(config)) {
			vulnerabilityAlerts = await step.do(
				"fetch-github-vulnerability-alerts",
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
				"query-osv-for-npm-vulnerabilities",
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

		const updateEntries = await Promise.all(
			ecosystems.map((eco) =>
				step.do(`fetch-outdated-${eco.ecosystem}-dependencies`, async () => {
					const manager = managerByName(eco.ecosystem);
					if (!manager) {
						return [eco.ecosystem, {} as UpdateRecord] as const;
					}
					const { octokit } = await repositoryAccessFor(
						organization,
						repository,
					);
					const datasource = datasourceFor(manager.datasource, octokit);
					if (!datasource) {
						return [eco.ecosystem, {} as UpdateRecord] as const;
					}
					const dependencies = eco.files.flatMap((file) => file.dependencies);
					const updates = await fetchOutdated(dependencies, datasource, {
						minimumReleaseAgeMs: minimumReleaseAge.ms,
					});
					return [eco.ecosystem, updates] as const;
				}),
			),
		);
		const updatesByEcosystem: Partial<Record<string, UpdateRecord>> =
			Object.fromEntries(updateEntries);

		const safeUpgrades = await step.do("list-safe-upgrades", async () => {
			return listSafeUpgrades(ecosystems, updatesByEcosystem);
		});

		let safeUpgradesDispatched = 0;
		if (safeUpgrades.length > 0) {
			safeUpgradesDispatched = await step.do(
				"dispatch-safe-upgrade-workflows",
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
			const pins: PinAction[] = ecosystems.flatMap((eco) =>
				eco.files.flatMap((file) =>
					file.dependencies
						.filter(
							(dep) =>
								dep.pinned === false &&
								dep.depType !== undefined &&
								dependencyTypePinned(config, dep.depType),
						)
						.map((dep) => ({
							ecosystem: eco.ecosystem,
							manifest: file.file,
							package: dep.name,
						})),
				),
			);

			const dashboardMarkdown = await step.do(
				"render-dashboard-markdown",
				async () =>
					renderDependencyDashboard({
						updatedAt: new Date(),
						minimumReleaseAge,
						ecosystems,
						updatesByEcosystem,
						pins,
						vulnerabilityAlerts,
						osvAlerts,
					}),
			);

			await step.do("sync-dependency-dashboard-issue", async () => {
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
