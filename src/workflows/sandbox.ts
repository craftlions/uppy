import type { WorkflowStep } from "cloudflare:workers";
import type { Sandbox } from "e2b";
import type { SafeUpgrade } from "../deps.ts";
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
export const WORKSPACE = "/workspace";

/** The workspace path the sandbox writes its {@link SandboxResult} handoff to. */
const RESULT_PATH = `${WORKSPACE}/result.json`;

/**
 * The full run-level payload one Manager workflow instance receives from the
 * orchestrator. {@link SafeUpgrade} is the per-upgrade data; the rest is context
 * the orchestrator has already resolved (default branch, the installation, and a
 * single short-lived installation token shared across the run).
 */
export interface UpgradeParams {
	organization: string;
	repository: string;
	defaultBranch: string;
	installationId: number;
	installationToken: string;
	upgrade: SafeUpgrade;
}

/**
 * The sandbox → worker handoff (see CONTEXT.md, "Manager workflow"). Written to
 * `/workspace/result.json` inside the sandbox and read back out, so the PR body
 * is rendered from a single source of truth rather than re-running git.
 */
export interface SandboxResult {
	commitSha: string;
	branch: string;
	diff: string;
	filesChanged: number;
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
	opts: { envs: Record<string, string> },
	fn: (sandbox: Sandbox) => Promise<T>,
): Promise<T> {
	const sandbox = await E2bSandbox.create(E2B_TEMPLATE, {
		apiKey: env.E2B_API_KEY,
		envs: opts.envs,
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
): Promise<string> {
	const { data } = await app.octokit.rest.apps.createInstallationAccessToken({
		installation_id: installationId,
	});
	return data.token;
}

/** The PR title and commit subject share the structured `chore(deps): …` shape. */
function prTitle(upgrade: SafeUpgrade, spec: ManagerUpgradeSpec): string {
	return spec.commitMessage(upgrade);
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

/** Throw when an e2b command exits non-zero so `step.do` retries and fails loudly. */
function ensureOk(
	label: string,
	result: { exitCode: number; stderr: string },
): void {
	if (result.exitCode !== 0) {
		throw new Error(
			`${label} failed (exit ${result.exitCode}): ${result.stderr}`,
		);
	}
}

/**
 * The full sandbox lifecycle for one upgrade: configure the bot identity, clone
 * the repository, check out the upgrade branch, run the Manager's update command,
 * commit (signed off) and force-push, then write and read back
 * `/workspace/result.json`. A "no changes" outcome throws rather than producing
 * an empty commit.
 */
async function runSandboxUpgrade(
	sandbox: Sandbox,
	params: UpgradeParams,
	branch: string,
	spec: ManagerUpgradeSpec,
): Promise<SandboxResult> {
	const { organization, repository, upgrade } = params;
	const cloneUrl = `https://github.com/${organization}/${repository}.git`;
	const run = (cmd: string) => sandbox.commands.run(cmd, { cwd: WORKSPACE });

	await sandbox.git.configureUser(BOT_NAME, BOT_EMAIL);
	ensureOk("clone", await sandbox.git.clone(cloneUrl, { path: WORKSPACE }));

	// `-B` lands re-runs on the same branch whether or not it already exists.
	ensureOk(`checkout ${branch}`, await run(`git checkout -B ${branch}`));
	ensureOk("update command", await run(spec.updateCommand(upgrade)));
	ensureOk("stage changes", await run("git add -A"));

	const staged = await run("git diff --cached --name-only");
	const filesChanged = staged.stdout.split("\n").filter(Boolean).length;
	if (filesChanged === 0) {
		throw new Error(
			`update command produced no changes for ${upgrade.package} -> ${upgrade.target}`,
		);
	}

	const diff = await run("git diff --cached");

	// Commit via a message file so backend-qualified package names never need
	// shell escaping; `--signoff` covers the SDK's missing signoff option.
	await sandbox.files.write(
		`${WORKSPACE}/.uppy-commit-msg`,
		spec.commitMessage(upgrade),
	);
	ensureOk("commit", await run("git commit --signoff -F .uppy-commit-msg"));

	ensureOk(
		"push",
		await run(`git push --force-with-lease --set-upstream origin ${branch}`),
	);

	const head = await run("git rev-parse HEAD");
	const result: SandboxResult = {
		commitSha: head.stdout.trim(),
		branch,
		diff: diff.stdout,
		filesChanged,
	};
	await sandbox.files.write(RESULT_PATH, JSON.stringify(result));
	return JSON.parse(await sandbox.files.read(RESULT_PATH)) as SandboxResult;
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

	const result = await step.do("run-sandbox-upgrade", async () =>
		withSandbox(
			env,
			{
				envs: {
					GIT_USERNAME: "x-access-token",
					GIT_TOKEN: params.installationToken,
				},
			},
			(sandbox) => runSandboxUpgrade(sandbox, params, branch, spec),
		),
	);

	await step.do("open-or-update-pr", async () => {
		const octokit = await getApp().getInstallationOctokit(
			params.installationId,
		);
		const body = renderPrBody(
			params.upgrade,
			result,
			await dashboardIssueUrl(octokit, params),
		);
		const title = prTitle(params.upgrade, spec);
		const { data: open } = await octokit.rest.pulls.list({
			owner: params.organization,
			repo: params.repository,
			state: "open",
			head,
		});
		if (open.length > 0) {
			await octokit.rest.pulls.update({
				owner: params.organization,
				repo: params.repository,
				pull_number: open[0].number,
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

	return result;
}
