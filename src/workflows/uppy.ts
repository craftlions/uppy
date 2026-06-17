import type { WorkflowEvent } from "cloudflare:workers";
import { WorkflowEntrypoint, type WorkflowStep } from "cloudflare:workers";
import {
	type PinAction,
	renderDependencyDashboard,
} from "../dependency-dashboard.ts";
import {
	listSafeUpgrades,
	type SafeUpgrade,
	type UpdateRecord,
} from "../deps.ts";
import { repositoryAccessFor } from "../github.ts";
import { workflowInstanceId } from "../ids.ts";
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
	resolveGroupName,
	vulnerabilityAlertsEnabled,
} from "../renovate.ts";
import { fetchUpdateCheckForManager } from "../update-check.ts";
import {
	type DependabotAlert,
	fetchVulnerabilityAlerts,
	logVulnerabilityAlerts,
} from "../vulnerability-alerts.ts";
import { DEFERRED_MANAGERS, managerWorkflowBinding } from "./dispatch.ts";
import {
	buildDesiredGroups,
	describeOpenPr,
	hasBlockedComment,
	type OpenUppyPr,
	reconcileDesiredGroups,
	renderBlockedComment,
	UPPY_BRANCH_PREFIX,
	upsertBlockedWarning,
} from "./reconcile.ts";
import {
	DASHBOARD_TITLE,
	findDashboardIssue,
	type UpgradeParams,
} from "./sandbox.ts";

type Params = { organization: string; repository: string };

export class UppyWorkflow extends WorkflowEntrypoint<Env, Params> {
	override async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
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

		const managerDependencies = await step.do(
			"detect-dependencies",
			async () => {
				const { octokit } = await repositoryAccessFor(organization, repository);
				return await detectDependencies(octokit, organization, repository);
			},
		);

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
					const npmManager = managerDependencies.find(
						(group) => group.manager === "npm",
					);
					const dependencies =
						npmManager?.files.flatMap((file) => file.dependencies) ?? [];
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
			managerDependencies.map((group) =>
				step.do(`update-check-${group.manager}`, async () => {
					const manager = managerByName(group.manager);
					if (!manager) {
						return [group.manager, {} as UpdateRecord] as const;
					}
					const { octokit } = await repositoryAccessFor(
						organization,
						repository,
					);
					const updates = await fetchUpdateCheckForManager(
						group,
						manager,
						(datasourceName) => datasourceFor(datasourceName, octokit),
						{ minimumReleaseAgeMs: minimumReleaseAge.ms },
					);
					return [group.manager, updates] as const;
				}),
			),
		);
		const updatesByManager: Partial<Record<string, UpdateRecord>> =
			Object.fromEntries(updateEntries);

		const safeUpgrades = await step.do("list-safe-upgrades", async () => {
			return listSafeUpgrades(
				managerDependencies,
				updatesByManager,
				config ? (dep) => resolveGroupName(config, dep) : undefined,
			);
		});

		const groups: Record<string, Record<string, string>> = {};
		if (config) {
			for (const group of managerDependencies) {
				if (!["npm", "mise"].includes(group.manager)) continue;
				const managerUpdates = updatesByManager[group.manager] ?? {};
				for (const file of group.files) {
					for (const dep of file.dependencies) {
						const status = managerUpdates[dep.name];
						const depForRule: {
							name: string;
							depType?: string;
							updateType?: string;
						} = { name: dep.name };
						if (dep.depType !== undefined) {
							depForRule.depType = dep.depType;
						}
						if (status?.updateType !== undefined) {
							depForRule.updateType = status.updateType;
						}
						const groupName = resolveGroupName(config, depForRule);
						if (groupName) {
							const managerGroups = groups[group.manager] ?? {};
							managerGroups[dep.name] = groupName;
							groups[group.manager] = managerGroups;
						}
					}
				}
			}
		}

		if (config && dependencyDashboardEnabled(config)) {
			const pins: PinAction[] = managerDependencies.flatMap((group) =>
				group.files.flatMap((file) =>
					file.dependencies
						.filter(
							(dep) =>
								dep.pinned === false &&
								dep.depType !== undefined &&
								dependencyTypePinned(config, dep.depType),
						)
						.map((dep) => ({
							manager: group.manager,
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
						managerDependencies,
						updatesByManager,
						groups,
						pins,
						vulnerabilityAlerts,
						osvAlerts,
					}),
			);

			await step.do("sync-dependency-dashboard-issue", async () => {
				const { octokit } = await repositoryAccessFor(organization, repository);
				const dashboard = await findDashboardIssue(
					octokit,
					organization,
					repository,
				);
				if (dashboard) {
					await octokit.rest.issues.update({
						owner: organization,
						repo: repository,
						issue_number: dashboard.number,
						body: dashboardMarkdown,
					});
				} else {
					await octokit.rest.issues.create({
						owner: organization,
						repo: repository,
						title: DASHBOARD_TITLE,
						body: dashboardMarkdown,
					});
				}
			});
		}

		// Validate every Manager (deferred ones included) maps to a binding, so a
		// typo or a new Manager surfaces here rather than being silently dropped.
		for (const upgrade of safeUpgrades) {
			managerWorkflowBinding(upgrade.manager);
		}
		const dispatchable = safeUpgrades.filter(
			(upgrade) => !DEFERRED_MANAGERS.has(upgrade.manager),
		);

		// Group desired upgrades exactly as dispatch does, so the branch we predict
		// for conflict detection matches the branch the Manager workflow creates.
		const desiredGroups = buildDesiredGroups(dispatchable);

		// Reconcile against open uppy PRs before dispatching: a newer update whose
		// intent overlaps an already-open uppy PR is held back (the older PR is
		// annotated) so at most one PR per dependency intent stays open. Groups with
		// no conflicting open PR — or whose branch already matches one (an in-place
		// update) — dispatch as today.
		const openUppyPrs =
			desiredGroups.length > 0
				? await step.do("list-open-uppy-prs", async () => {
						const { octokit } = await repositoryAccessFor(
							organization,
							repository,
						);
						const { data: prs } = await octokit.rest.pulls.list({
							owner: organization,
							repo: repository,
							state: "open",
							per_page: 100,
						});
						return prs
							.filter((pr) => pr.head?.ref?.startsWith(UPPY_BRANCH_PREFIX))
							.map((pr) => describeOpenPr(pr))
							.filter((pr): pr is OpenUppyPr => pr !== null);
					})
				: [];

		const reconciled = reconcileDesiredGroups(desiredGroups, openUppyPrs);
		const blocked = reconciled.filter((entry) => entry.blockedBy);
		const allowedGroups = reconciled
			.filter((entry) => !entry.blockedBy)
			.map((entry) => entry.group);

		// Annotate each blocked PR once: a single explanatory comment across runs and
		// an idempotent warning block at the top of the PR body. Keyed by PR number
		// so two desired groups blocked by the same PR annotate it only once.
		if (blocked.length > 0) {
			await step.do("annotate-blocked-prs", async () => {
				const { octokit } = await repositoryAccessFor(organization, repository);
				// Aggregate every held-back upgrade per blocking PR: one PR can block
				// several desired groups at once, and the annotation must list them all.
				const byPr = new Map<number, SafeUpgrade[]>();
				for (const entry of blocked) {
					if (!entry.blockedBy) {
						continue;
					}
					const list = byPr.get(entry.blockedBy.number) ?? [];
					list.push(...entry.group.upgrades);
					byPr.set(entry.blockedBy.number, list);
				}
				for (const [prNumber, upgrades] of byPr) {
					const { data: comments } = await octokit.rest.issues.listComments({
						owner: organization,
						repo: repository,
						issue_number: prNumber,
						per_page: 100,
					});
					if (!hasBlockedComment(comments)) {
						await octokit.rest.issues.createComment({
							owner: organization,
							repo: repository,
							issue_number: prNumber,
							body: renderBlockedComment(upgrades),
						});
					}
					const { data: pr } = await octokit.rest.pulls.get({
						owner: organization,
						repo: repository,
						pull_number: prNumber,
					});
					const updatedBody = upsertBlockedWarning(pr.body ?? "", upgrades);
					if (updatedBody !== (pr.body ?? "")) {
						await octokit.rest.pulls.update({
							owner: organization,
							repo: repository,
							pull_number: prNumber,
							body: updatedBody,
						});
					}
				}
			});
		}

		// Dispatched last, after the dashboard is synced, so the dashboard reflects
		// this run even if a Manager workflow dispatch fails.
		let safeUpgradesDispatched = 0;
		if (allowedGroups.length > 0) {
			safeUpgradesDispatched = await step.do(
				"dispatch-safe-upgrade-workflows",
				async () => {
					const { defaultBranch, installationId } = await repositoryAccessFor(
						organization,
						repository,
					);
					console.log(
						`Dispatching Manager workflows for ${organization}/${repository} using installation ${installationId}`,
					);
					const runContext = {
						organization,
						repository,
						defaultBranch,
						installationId,
					};

					// Group by binding so each Manager workflow gets one createBatch.
					const byBinding = new Map<keyof Env, SafeUpgrade[][]>();
					for (const group of allowedGroups) {
						const binding = managerWorkflowBinding(group.manager);
						const list = byBinding.get(binding) ?? [];
						list.push(group.upgrades);
						byBinding.set(binding, list);
					}

					let dispatched = 0;
					for (const [binding, upgradeGroups] of byBinding) {
						const workflow = this.env[binding] as Workflow<UpgradeParams>;
						const instances = await workflow.createBatch(
							upgradeGroups.map((upgrades) => {
								const first = upgrades[0];
								if (!first) {
									throw new Error("Empty upgrade group cannot be dispatched");
								}
								const id = workflowInstanceId(event.instanceId, first.manager);
								return {
									id,
									params: { ...runContext, upgrades, instanceId: id },
								};
							}),
						);
						dispatched += instances.length;
					}
					return dispatched;
				},
			);
		}

		return {
			organization,
			repository,
			configPath: detectedConfig?.path ?? null,
			safeUpgradesDispatched,
		};
	}
}
