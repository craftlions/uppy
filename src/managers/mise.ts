import type { WorkflowEvent } from "cloudflare:workers";
import type { Manager } from "../manager.ts";
import { WorkflowEntrypoint, type WorkflowStep } from "cloudflare:workers";
import {
	type DependencyFile,
	fetchFileContent,
	parseMiseToml,
	type SafeUpgrade,
	updateMiseToml,
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
 * Update the `[tools]` entry for this upgrade directly in `mise.toml`, returning
 * the rewritten file. Editing the TOML in place is what keeps the full, quoted
 * mise backend key (e.g. `"core:node"`, `"github:endevco/aube"`) intact: the old
 * `mise use <tool>@<target>` rewrote `"core:node"` to bare `node`, breaking
 * uppy's backend identity contract, and also failed outright on a freshly cloned,
 * untrusted config. {@link miseInstallCommand} validates the edit afterwards.
 */
export function miseUpdateManifest(
	content: string,
	upgrade: SafeUpgrade,
): string {
	return updateMiseToml(content, upgrade.package, upgrade.target);
}

/**
 * The shell command that validates a mise upgrade after the direct manifest edit:
 * `mise trust -y` trusts the freshly cloned config (an untrusted config makes
 * `mise install` exit non-zero), then `mise install` installs the new version and
 * refreshes `mise.lock`. A non-zero `mise install` — for example when the new
 * release would weaken lockfile provenance — is a failed safe upgrade: the
 * sandbox surfaces its stderr and the run stops before any PR is published.
 */
export function miseInstallCommand(_upgrade: SafeUpgrade): string {
	return "mise trust -y && mise install";
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
			editManifest: miseUpdateManifest,
			updateCommand: miseInstallCommand,
			commitMessage: miseCommitMessage,
		});
	}
}
