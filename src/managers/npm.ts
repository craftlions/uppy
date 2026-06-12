import type { WorkflowEvent } from "cloudflare:workers";
import type { Manager } from "../manager.ts";
import { WorkflowEntrypoint, type WorkflowStep } from "cloudflare:workers";
import {
	type DependencyFile,
	fetchFileContent,
	parsePackageJson,
	type SafeUpgrade,
} from "../deps.ts";
import { runManagerUpgrade, type UpgradeParams } from "../workflows/sandbox.ts";

const PACKAGE_JSON = "package.json";

/**
 * The npm {@link Manager}: reads `package.json` and parses its `dependencies` and
 * `devDependencies`. Resolved through the like-named `npm` datasource.
 */
export const npmManager: Manager = {
	name: "npm",
	datasource: "npm",
	async detect(octokit, owner, repo): Promise<DependencyFile[]> {
		const content = await fetchFileContent(octokit, owner, repo, PACKAGE_JSON);
		if (!content) {
			return [];
		}
		const dependencies = parsePackageJson(content);
		return dependencies.length > 0
			? [{ file: PACKAGE_JSON, dependencies }]
			: [];
	},
};

/**
 * The shell command that updates an npm dependency. Runs `aube add <pkg>@<target>`
 * through a hermetic `mise exec` (no repo config, env, or hooks) so the update
 * does not depend on the target repo's mise setup. Appends `-D` when the
 * dependency lives in `devDependencies`, so it is added with the right section.
 */
export function npmUpdateCommand(upgrade: SafeUpgrade): string {
	const base = `mise --no-config --no-env --no-hooks exec aube@latest node@latest -- aube add ${upgrade.package}@${upgrade.target}`;
	return upgrade.depType === "devDependencies" ? `${base} -D` : base;
}

/** The structured commit subject for an npm upgrade, Renovate-style. */
export function npmCommitMessage(upgrade: SafeUpgrade): string {
	return `chore(deps): update ${upgrade.package} from ${upgrade.current} to ${upgrade.target}`;
}

/**
 * The shell command that updates a group of npm dependencies. Runs `aube add`
 * for each package in sequence through a hermetic `mise exec`. Appends `-D`
 * when a dependency lives in `devDependencies`.
 */
export function npmUpdateCommandGrouped(upgrades: SafeUpgrade[]): string {
	if (!upgrades || upgrades.length === 0) {
		throw new Error("npmUpdateCommandGrouped requires at least one upgrade");
	}
	return upgrades
		.map((upgrade) => {
			const base = `mise --no-config --no-env --no-hooks exec aube@latest node@latest -- aube add ${upgrade.package}@${upgrade.target}`;
			return upgrade.depType === "devDependencies" ? `${base} -D` : base;
		})
		.join(" && ");
}

/** The structured commit subject for a grouped npm upgrade. */
export function npmCommitMessageGrouped(upgrades: SafeUpgrade[]): string {
	const names = upgrades.map((upgrade) => upgrade.package).join(", ");
	const groupName = upgrades[0]?.groupName;
	const consistent =
		groupName !== undefined &&
		upgrades.every((upgrade) => upgrade.groupName === groupName);
	return consistent
		? `chore(deps): update ${groupName} (${names})`
		: `chore(deps): update ${names}`;
}

/**
 * The npm Manager workflow (see CONTEXT.md, "Manager workflow"): one instance per
 * Safe npm upgrade. Runs the full closed-PR check → sandbox → commit → push → PR
 * cycle via {@link runManagerUpgrade}, with the npm update command and commit
 * message.
 */
export class NpmWorkflow extends WorkflowEntrypoint<Env, UpgradeParams> {
	override async run(event: WorkflowEvent<UpgradeParams>, step: WorkflowStep) {
		return runManagerUpgrade(this.env, step, event.payload, {
			updateCommand: npmUpdateCommand,
			commitMessage: npmCommitMessage,
			updateCommandGrouped: npmUpdateCommandGrouped,
			commitMessageGrouped: npmCommitMessageGrouped,
		});
	}
}
