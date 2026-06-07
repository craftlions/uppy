import type { WorkflowEvent } from "cloudflare:workers";
import type { Manager } from "../manager.ts";
import { WorkflowEntrypoint, type WorkflowStep } from "cloudflare:workers";
import {
	type DependencyFile,
	fetchFileContent,
	parseMiseToml,
	type SafeUpgrade,
} from "../deps.ts";
import { runManagerUpgrade, type UpgradeParams } from "../workflows/sandbox.ts";

const MISE_TOML = "mise.toml";

/**
 * The mise {@link Manager}: reads `mise.toml` and parses its `[tools]` table.
 * Resolved through the like-named `mise` datasource.
 */
export const miseManager: Manager = {
	name: "mise",
	async detect(octokit, owner, repo): Promise<DependencyFile[]> {
		const content = await fetchFileContent(octokit, owner, repo, MISE_TOML);
		if (!content) {
			return [];
		}
		const dependencies = parseMiseToml(content);
		return dependencies.length > 0 ? [{ file: MISE_TOML, dependencies }] : [];
	},
};

/**
 * The shell command that updates a mise tool: `mise use <tool>@<target>` in the
 * full mise env at the repo root, so the user's existing `mise.toml` settings
 * are respected. The `package` is the full backend identity (e.g.
 * `npm:@openai/codex`); mise resolves it to the right backend.
 */
export function miseUpdateCommand(upgrade: SafeUpgrade): string {
	return `mise use ${upgrade.package}@${upgrade.target}`;
}

/**
 * The structured commit subject for a mise upgrade. Uses the full mise backend
 * identity as the package name (e.g. `npm:@openai/codex`), Renovate-style.
 */
export function miseCommitMessage(upgrade: SafeUpgrade): string {
	return `chore(deps): update ${upgrade.package} from ${upgrade.current} to ${upgrade.target}`;
}

/**
 * The mise Manager workflow (see CONTEXT.md, "Manager workflow"): one instance
 * per Safe mise upgrade. Runs the full closed-PR check → sandbox → commit → push
 * → PR cycle via {@link runManagerUpgrade}, with the mise update command and
 * commit message.
 */
export class MiseWorkflow extends WorkflowEntrypoint<Env, UpgradeParams> {
	async run(event: WorkflowEvent<UpgradeParams>, step: WorkflowStep) {
		return runManagerUpgrade(this.env, step, event.payload, {
			updateCommand: miseUpdateCommand,
			commitMessage: miseCommitMessage,
		});
	}
}
