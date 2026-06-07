import type { WorkflowStep } from "cloudflare:workers";
import type { Sandbox } from "e2b";
import type { SafeUpgrade } from "../deps.ts";
import { NonRetryableError } from "cloudflare:workflows";
import { Sandbox as E2bSandbox } from "e2b";
import { type GithubApp, getApp } from "../github.ts";
import { safeUpgradeBranch } from "./branches.ts";

/**
 * The published e2b template every Manager workflow boots from. Single source of
 * truth — swapping templates is a one-line change here (see CONTEXT.md, "Manager
 * workflow").
 */
export const E2B_TEMPLATE = "craftlions/uppy-base";

/** The uppy bot's git identity, used to author every commit inside the sandbox. */
export const BOT_NAME = "craftlions-uppy[bot]";
export const BOT_EMAIL = "craftlions-uppy[bot]@users.noreply.github.com";

/** Where every Manager workflow clones the target repository inside the sandbox. */
export const WORKSPACE = "/home/user/workspace";

/**
 * The full run-level payload one Manager workflow instance receives from the
 * orchestrator. {@link SafeUpgrade} is the per-upgrade data; the rest is context
 * the orchestrator has already resolved (default branch and installation). The
 * Manager workflow mints its short-lived installation token inside the sandbox
 * step so retries or delayed child workflow starts never reuse an expired token.
 */
export interface UpgradeParams {
	organization: string;
	repository: string;
	defaultBranch: string;
	installationId: number;
	upgrade: SafeUpgrade;
}

/**
 * The sandbox → worker handoff (see CONTEXT.md, "Manager workflow"): the
 * structured result the sandbox step returns, so the PR body is rendered from a
 * single source of truth rather than re-running git.
 */
export interface SandboxResult {
	commitSha: string;
	branch: string;
	diff: string;
	filesChanged: number;
}

interface SandboxFileChange {
	path: string;
	content?: string;
	deleted?: boolean;
}

interface SandboxUpgradeResult extends SandboxResult {
	changes: SandboxFileChange[];
}

/**
 * The Manager-specific half of an upgrade run: the static shell command that
 * updates the manifest and the structured commit message. Both are pure
 * functions of the {@link SafeUpgrade}, exported per Manager and co-located with
 * the Manager they serve.
 */
export interface ManagerUpgradeSpec {
	updateCommand: (upgrade: SafeUpgrade) => string;
	commitMessage: (upgrade: SafeUpgrade) => string;
}

/**
 * Create an e2b sandbox from {@link E2B_TEMPLATE}, run `fn` against it, and kill
 * it in a `finally` so a thrown error never leaks the sandbox. Every sandbox
 * caller goes through here for one uniform create → run → kill lifecycle.
 */
export async function withSandbox<T>(
	env: Env,
	opts: {
		envs: Record<string, string>;
		timeoutMs?: number;
		allowInternetAccess?: boolean;
	},
	fn: (sandbox: Sandbox) => Promise<T>,
): Promise<T> {
	const createOpts = {
		apiKey: env.E2B_API_KEY,
		envs: opts.envs,
	};
	const sandbox = await E2bSandbox.create(E2B_TEMPLATE, {
		...createOpts,
		...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
		...(opts.allowInternetAccess === undefined
			? {}
			: { allowInternetAccess: opts.allowInternetAccess }),
	});
	try {
		return await fn(sandbox);
	} finally {
		await sandbox.kill();
	}
}

/**
 * Mint a short-lived installation access token for `installationId`. The
 * orchestrator calls this once per run and threads the token to every child
 * Manager workflow, so the run shares one auth without re-minting.
 */
export async function mintInstallationToken(
	app: GithubApp,
	installationId: number,
	repository: string,
): Promise<string> {
	const { data } = await app.octokit.rest.apps.createInstallationAccessToken({
		installation_id: installationId,
		repositories: [repository],
	});
	return data.token;
}

/**
 * Render the PR body: a structured metadata header (Package, From, To, Manifest,
 * Bump type), an optional link back to the Dependency Dashboard issue, and the
 * inline diff. The single source of the PR-body Markdown shape.
 */
export function renderPrBody(
	upgrade: SafeUpgrade,
	result: SandboxResult,
	dashboardIssueUrl?: string,
): string {
	const lines = [
		"| | |",
		"| --- | --- |",
		`| Package | \`${upgrade.package}\` |`,
		`| From | \`${upgrade.current}\` |`,
		`| To | \`${upgrade.target}\` |`,
		`| Manifest | \`${upgrade.manifest}\` |`,
		`| Bump type | ${upgrade.updateType} |`,
		"",
	];
	if (dashboardIssueUrl) {
		lines.push(
			`See the uppy [Dependency Dashboard](${dashboardIssueUrl}) for the broader context.`,
			"",
		);
	}
	lines.push("```diff", result.diff.trimEnd(), "```", "");
	return lines.join("\n");
}

interface CommandResultLike {
	exitCode: number;
	error?: string;
	stdout?: string;
	stderr: string;
}

function commandFailed(label: string, result: CommandResultLike): Error {
	const details = [result.stderr, result.stdout, result.error]
		.filter((part) => part && part.trim().length > 0)
		.join("\n");
	return new Error(
		`${label} failed (exit ${result.exitCode})${details ? `: ${details}` : ""}`,
	);
}

function commitMessageWithSignoff(message: string): string {
	return `${message}\n\nSigned-off-by: ${BOT_NAME} <${BOT_EMAIL}>`;
}

interface CompareFileLike {
	filename?: string;
	patch?: string;
}

interface CompareCommitLike {
	sha?: string;
}

interface CompareResponseLike {
	data?: {
		commits?: CompareCommitLike[];
		files?: CompareFileLike[];
	};
}

interface GitRefResponseLike {
	data: {
		object: {
			sha: string;
		};
	};
}

interface GitCommitResponseLike {
	data: {
		tree: {
			sha: string;
		};
	};
}

interface GitCreateTreeResponseLike {
	data: {
		sha: string;
	};
}

interface GitCreateCommitResponseLike {
	data: {
		sha: string;
	};
}

function renderCompareDiff(files: CompareFileLike[] = []): string {
	return files
		.map((file) => {
			const filename = file.filename ?? "unknown";
			const patch = file.patch ?? "";
			return [`diff --git a/${filename} b/${filename}`, patch]
				.filter(Boolean)
				.join("\n");
		})
		.join("\n");
}

function isNotFound(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"status" in error &&
		error.status === 404
	);
}

/** The open uppy Dependency Dashboard issue URL, or undefined when none exists. */
async function dashboardIssueUrl(
	octokit: Awaited<ReturnType<GithubApp["getInstallationOctokit"]>>,
	params: UpgradeParams,
): Promise<string | undefined> {
	try {
		const { data } = await octokit.rest.issues.listForRepo({
			owner: params.organization,
			repo: params.repository,
			state: "open",
			creator: BOT_NAME,
		});
		return data.find((issue) => !issue.pull_request)?.html_url;
	} catch {
		return undefined;
	}
}

async function branchExists(
	octokit: Awaited<ReturnType<GithubApp["getInstallationOctokit"]>>,
	params: UpgradeParams,
	branch: string,
): Promise<boolean> {
	try {
		await octokit.rest.git.getRef({
			owner: params.organization,
			repo: params.repository,
			ref: `heads/${branch}`,
		});
		return true;
	} catch (error) {
		if (isNotFound(error)) {
			return false;
		}
		throw error;
	}
}

async function publishBranchFromChanges(
	octokit: Awaited<ReturnType<GithubApp["getInstallationOctokit"]>>,
	params: UpgradeParams,
	result: SandboxUpgradeResult,
	spec: ManagerUpgradeSpec,
): Promise<string> {
	const baseRef = (await octokit.rest.git.getRef({
		owner: params.organization,
		repo: params.repository,
		ref: `heads/${params.defaultBranch}`,
	})) as GitRefResponseLike;
	const baseSha = baseRef.data.object.sha;
	const baseCommit = (await octokit.rest.git.getCommit({
		owner: params.organization,
		repo: params.repository,
		commit_sha: baseSha,
	})) as GitCommitResponseLike;
	const tree = (await octokit.rest.git.createTree({
		owner: params.organization,
		repo: params.repository,
		base_tree: baseCommit.data.tree.sha,
		tree: result.changes.map((change) => ({
			path: change.path,
			mode: "100644",
			type: "blob",
			...(change.deleted ? { sha: null } : { content: change.content ?? "" }),
		})),
	})) as GitCreateTreeResponseLike;
	const commit = (await octokit.rest.git.createCommit({
		owner: params.organization,
		repo: params.repository,
		message: commitMessageWithSignoff(spec.commitMessage(params.upgrade)),
		tree: tree.data.sha,
		parents: [baseSha],
		author: {
			name: BOT_NAME,
			email: BOT_EMAIL,
		},
		committer: {
			name: BOT_NAME,
			email: BOT_EMAIL,
		},
	})) as GitCreateCommitResponseLike;

	const ref = `heads/${result.branch}`;
	if (await branchExists(octokit, params, result.branch)) {
		await octokit.rest.git.updateRef({
			owner: params.organization,
			repo: params.repository,
			ref,
			sha: commit.data.sha,
			force: true,
		});
	} else {
		await octokit.rest.git.createRef({
			owner: params.organization,
			repo: params.repository,
			ref: `refs/${ref}`,
			sha: commit.data.sha,
		});
	}
	return commit.data.sha;
}

/**
 * Run the full closed-PR check → sandbox → PR cycle for one Manager workflow
 * instance. Returns `"no-op"` when a closed PR already exists for the branch;
 * otherwise opens a new PR or updates the existing open one and returns the
 * {@link SandboxResult}. Each phase is its own `step.do` so Cloudflare retries
 * transient failures.
 */
export async function runManagerUpgrade(
	env: Env,
	step: WorkflowStep,
	params: UpgradeParams,
	spec: ManagerUpgradeSpec,
): Promise<"no-op" | SandboxResult> {
	const branch = safeUpgradeBranch(params.upgrade);
	const head = `${params.organization}:${branch}`;

	const closedPrExists = await step.do("check-for-closed-pr", async () => {
		const octokit = await getApp().getInstallationOctokit(
			params.installationId,
		);
		const { data } = await octokit.rest.pulls.list({
			owner: params.organization,
			repo: params.repository,
			state: "closed",
			head,
		});
		return data.length > 0;
	});
	if (closedPrExists) {
		return "no-op";
	}

	const openPr = await step.do("check-for-open-pr", async () => {
		const octokit = await getApp().getInstallationOctokit(
			params.installationId,
		);
		const { data } = await octokit.rest.pulls.list({
			owner: params.organization,
			repo: params.repository,
			state: "open",
			head,
		});
		return data[0];
	});

	const result = await step.do("run-sandbox-upgrade", async () => {
		console.log(
			`Minting installation token for ${params.organization}/${params.repository} from installation ${params.installationId}`,
		);
		const installationToken = await mintInstallationToken(
			getApp(),
			params.installationId,
			params.repository,
		);
		console.log(
			`Minted installation token for ${params.organization}/${params.repository} with length ${installationToken.length}`,
		);
		return await withSandbox(
			env,
			{ envs: {}, timeoutMs: 600_000, allowInternetAccess: true },
			async (sandbox) => {
				const gitCredentials = {
					username: "x-access-token",
					password: installationToken,
				};
				const cloneUrl = `https://github.com/${params.organization}/${params.repository}.git`;
				console.log(
					`Preparing sandbox upgrade for ${params.organization}/${params.repository} on ${branch} with token length ${installationToken.length}`,
				);
				await sandbox.git.configureUser(BOT_NAME, BOT_EMAIL);
				await sandbox.git.dangerouslyAuthenticate(gitCredentials);
				const clone = await sandbox.git.clone(cloneUrl, {
					...gitCredentials,
					branch: params.defaultBranch,
					depth: 1,
					path: WORKSPACE,
				});
				console.log(clone);
				console.log(
					`Creating local branch ${branch} from ${params.defaultBranch}`,
				);
				const createBranch = await sandbox.git.createBranch(".", branch, {
					cwd: WORKSPACE,
				});
				console.log(createBranch);
				const update = await sandbox.commands.run(
					spec.updateCommand(params.upgrade),
					{
						cwd: WORKSPACE,
						timeoutMs: 300_000,
						onStderr: (chunk) => console.error(`STDERR: ${chunk}`),
						onStdout: (chunk) => console.log(`STDOUT: ${chunk}`),
					},
				);
				console.log(update);
				if (update.exitCode !== 0) {
					throw commandFailed("update command", update);
				}
				const add = await sandbox.git.add(".", { all: true, cwd: WORKSPACE });
				console.log(add);
				const status = await sandbox.git.status(".", { cwd: WORKSPACE });
				const filesChanged = status.stagedCount;
				if (filesChanged === 0) {
					throw new NonRetryableError(
						`update command produced no changes for ${params.upgrade.package} -> ${params.upgrade.target}`,
					);
				}
				const changes = await Promise.all(
					status.fileStatus
						.filter((file) => file.staged)
						.map(async (file) => {
							const path = file.name;
							if (file.status === "deleted") {
								return { path, deleted: true };
							}
							return {
								path,
								content: await sandbox.files.read(`${WORKSPACE}/${path}`),
							};
						}),
				);

				return {
					commitSha: "",
					branch,
					diff: "",
					filesChanged,
					changes,
				} satisfies SandboxUpgradeResult;
			},
		);
	});

	await step.do("publish-branch", async () => {
		const octokit = await getApp().getInstallationOctokit(
			params.installationId,
		);
		result.commitSha = await publishBranchFromChanges(
			octokit,
			params,
			result,
			spec,
		);
	});

	await step.do("open-or-update-pr", async () => {
		const octokit = await getApp().getInstallationOctokit(
			params.installationId,
		);
		const compare = (await octokit.rest.repos.compareCommitsWithBasehead({
			owner: params.organization,
			repo: params.repository,
			basehead: `${params.defaultBranch}...${branch}`,
		})) as CompareResponseLike;
		const commits = compare.data?.commits ?? [];
		const files = compare.data?.files ?? [];
		result.commitSha = commits.at(-1)?.sha ?? result.commitSha;
		result.diff = renderCompareDiff(files);
		result.filesChanged = files.length || result.filesChanged;

		const body = renderPrBody(
			params.upgrade,
			result,
			await dashboardIssueUrl(octokit, params),
		);
		// The PR title and commit subject share the structured `chore(deps): …` shape.
		const title = spec.commitMessage(params.upgrade);
		if (openPr !== undefined) {
			await octokit.rest.pulls.update({
				owner: params.organization,
				repo: params.repository,
				pull_number: openPr.number,
				title,
				body,
			});
		} else {
			await octokit.rest.pulls.create({
				owner: params.organization,
				repo: params.repository,
				head: branch,
				base: params.defaultBranch,
				title,
				body,
			});
		}
	});

	return {
		commitSha: result.commitSha,
		branch: result.branch,
		diff: result.diff,
		filesChanged: result.filesChanged,
	};
}
