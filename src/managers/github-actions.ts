import type { WorkflowEvent } from "cloudflare:workers";
import type { Manager } from "../manager.ts";
import type { UpgradeParams } from "../workflows/sandbox.ts";
import { WorkflowEntrypoint, type WorkflowStep } from "cloudflare:workers";
import {
	type ContentReader,
	type Dependency,
	type DependencyFile,
	fetchFileContent,
} from "../deps.ts";

const WORKFLOWS_DIR = ".github/workflows";
const WORKFLOW_FILE = /\.ya?ml$/;
const SHA = /^[0-9a-f]{40}$/i;

/**
 * Matches a workflow `uses: owner/repo@ref` step, capturing the action
 * (`owner/repo` — exactly one slash, so subdir actions and reusable-workflow
 * refs are deferred), the `@ref` (tag, coarse tag, sha, or branch), and an
 * optional trailing `# comment`. `docker://` and local `./` refs do not match.
 */
const USES_LINE =
	/^\s*-?\s*uses:\s*["']?([^/\s"']+\/[^/@\s"']+)@([^\s"'#]+)["']?(?:\s*#\s*(\S.*?))?\s*$/;

/** Whether a github content-listing entry is a workflow file we should scan. */
interface DirEntry {
	type?: string;
	path?: string;
}

/**
 * Scan a workflow file for `uses:` action references. One dependency per distinct
 * action (first ref wins), tagged `depType: "action"`, with the raw `@ref` as the
 * version and any trailing comment kept for display. The ref is the ground-truth
 * value; the github-tags datasource resolves a sha to its version.
 */
export function parseWorkflowUses(content: string): Dependency[] {
	const dependencies: Dependency[] = [];
	const seen = new Set<string>();
	for (const line of content.split("\n")) {
		const match = USES_LINE.exec(line);
		if (!match) {
			continue;
		}
		const [, name, ref, comment] = match;
		if (seen.has(name)) {
			continue;
		}
		seen.add(name);
		const dependency: Dependency = {
			name,
			version: ref,
			depType: "action",
			pinned: SHA.test(ref),
		};
		if (comment) {
			dependency.comment = comment.trim();
		}
		dependencies.push(dependency);
	}
	return dependencies;
}

/** List the workflow files under `.github/workflows`, or none on any error. */
async function listWorkflowFiles(
	octokit: ContentReader,
	owner: string,
	repo: string,
): Promise<string[]> {
	try {
		const { data } = await octokit.rest.repos.getContent({
			owner,
			repo,
			path: WORKFLOWS_DIR,
		});
		if (!Array.isArray(data)) {
			return [];
		}
		return (data as DirEntry[])
			.filter(
				(entry): entry is { type: string; path: string } =>
					entry?.type === "file" &&
					typeof entry.path === "string" &&
					WORKFLOW_FILE.test(entry.path),
			)
			.map((entry) => entry.path)
			.sort();
	} catch {
		return [];
	}
}

/**
 * The github-actions {@link Manager}: enumerates `.github/workflows/*.{yml,yaml}`
 * and extracts each `uses: owner/repo@ref` action. Resolved through the
 * `github-tags` datasource.
 */
export const githubActionsManager: Manager = {
	name: "github-actions",
	datasource: "github-tags",
	async detect(octokit, owner, repo): Promise<DependencyFile[]> {
		const paths = await listWorkflowFiles(octokit, owner, repo);
		const files = await Promise.all(
			paths.map(async (file) => {
				const content = await fetchFileContent(octokit, owner, repo, file);
				return {
					file,
					dependencies: content ? parseWorkflowUses(content) : [],
				};
			}),
		);
		return files.filter((file) => file.dependencies.length > 0);
	},
};

/**
 * The github-actions Manager workflow (see CONTEXT.md, "Manager workflow"): a
 * deferred stub. It returns `"no-op"` until an `aube action` subcommand exists to
 * update a `uses:` ref; the orchestrator skips dispatching it in the meantime.
 */
export class GithubActionsWorkflow extends WorkflowEntrypoint<
	Env,
	UpgradeParams
> {
	async run(_event: WorkflowEvent<UpgradeParams>, _step: WorkflowStep) {
		return "no-op";
	}
}
