import type { WorkflowEvent } from "cloudflare:workers";
import { WorkflowEntrypoint, type WorkflowStep } from "cloudflare:workers";
import { repositoryAccessFor } from "../github.ts";

type Params = { branch?: string };

export class MiseWorkflow extends WorkflowEntrypoint<Env, Params> {
	async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
		// check for closed PR for the branch
		const closedPRExists = await step.do("check for closed PR", async () => {
			const access = await repositoryAccessFor("craftlions", "website");
			const octokit = access.octokit;
			const { data: prs } = await octokit.rest.pulls.list({
				owner: "craftlions",
				repo: "website",
				state: "closed",
				head: `${event.payload.branch}`,
			});
			console.log(
				`Found ${prs.length} closed PRs for branch ${event.payload.branch}`,
			);
			return prs.length > 0;
		});

		if (closedPRExists) {
			return "no-op";
		}
		// if yes, do nothing
		// if no, start the sandbox
		// update the PR with description
	}
}
