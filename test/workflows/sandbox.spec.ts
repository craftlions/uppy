import type { WorkflowStep } from "cloudflare:workers";
import type { SafeUpgrade } from "../../src/deps.ts";
import { NonRetryableError } from "cloudflare:workflows";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	miseCommitMessage,
	miseCommitMessageGrouped,
	miseInstallCommand,
	miseUpdateManifest,
} from "../../src/managers/mise.ts";

// Shared mutable state the import-level mocks read from. Each test assigns a
// fresh fake octokit / sandbox before driving the workflow.
const h = vi.hoisted(() => {
	// Mirror e2b's `CommandExitError`: thrown by `commands.run` on any non-zero
	// exit and carrying the command's exit code / stdout / stderr. Hoisted so the
	// `vi.mock("e2b")` factory below can re-export it.
	class CommandExitError extends Error {
		exitCode: number;
		stdout: string;
		stderr: string;
		error?: string | undefined;
		constructor(result: {
			exitCode: number;
			stdout: string;
			stderr: string;
			error?: string | undefined;
		}) {
			super(`exit status ${result.exitCode}`);
			this.name = "CommandExitError";
			this.exitCode = result.exitCode;
			this.stdout = result.stdout;
			this.stderr = result.stderr;
			this.error = result.error;
		}
	}
	return {
		sandbox: null as unknown,
		octokit: null as unknown,
		createInstallationAccessToken: vi.fn(async () => ({
			data: { token: "tok-xyz" },
		})),
		CommandExitError,
	};
});

vi.mock("e2b", () => ({
	Sandbox: { create: vi.fn(async () => h.sandbox) },
	CommandExitError: h.CommandExitError,
}));

vi.mock("../../src/github.ts", () => ({
	getApp: () => ({
		getInstallationOctokit: async () => h.octokit,
		octokit: {
			rest: {
				apps: {
					createInstallationAccessToken: h.createInstallationAccessToken,
				},
			},
		},
	}),
}));

import { Sandbox } from "e2b";
import { getApp } from "../../src/github.ts";
import {
	BOT_EMAIL,
	BOT_NAME,
	DASHBOARD_TITLE,
	E2B_TEMPLATE,
	findDashboardIssue,
	mintInstallationToken,
	normalizeUpgrades,
	renderPrBody,
	runManagerUpgrade,
	type UpgradeParams,
	WORKSPACE,
	withSandbox,
} from "../../src/workflows/sandbox.ts";
import { safeUpgradeGroupBranch } from "../../src/workflows/branches.ts";

type Cmd = { exitCode: number; stdout: string; stderr: string };
const OK: Cmd = { exitCode: 0, stdout: "", stderr: "" };

/** The starting `mise.toml` the fake sandbox serves: the upgrade's `[tools]`
 * entry at its current version, so an `editManifest` step has something to read
 * and rewrite. */
const INITIAL_MISE_TOML = '[tools]\n"npm:@openai/codex" = "0.63.0"\n';

/** A fake e2b sandbox: git/commands/files/kill spies with sane SDK results. */
function makeSandbox(opts?: {
	runImpl?: (cmd: string) => Cmd;
	stagedCount?: number;
	miseToml?: string;
}) {
	const store: Record<string, string> = {
		[`${WORKSPACE}/mise.toml`]: opts?.miseToml ?? INITIAL_MISE_TOML,
	};
	const run =
		opts?.runImpl ??
		((_cmd: string): Cmd => {
			return OK;
		});
	const stagedCount = opts?.stagedCount ?? 1;
	return {
		git: {
			configureUser: vi.fn(async () => OK),
			dangerouslyAuthenticate: vi.fn(async () => OK),
			clone: vi.fn(async () => OK),
			createBranch: vi.fn(async () => OK),
			add: vi.fn(async () => OK),
			status: vi.fn(async () => ({
				ahead: 0,
				behind: 0,
				conflictCount: 0,
				detached: false,
				fileStatus: stagedCount
					? [
							{
								indexStatus: "M",
								name: "mise.toml",
								staged: true,
								status: "modified",
								workingTreeStatus: " ",
							},
						]
					: [],
				hasChanges: stagedCount > 0,
				hasConflicts: false,
				hasStaged: stagedCount > 0,
				hasUntracked: false,
				isClean: stagedCount === 0,
				stagedCount,
				totalCount: stagedCount,
				unstagedCount: 0,
				untrackedCount: 0,
			})),
			commit: vi.fn(async () => ({
				...OK,
				stdout:
					"[uppy/mise-npm-openai-codex-0.64.0 abc1234] chore(deps): update npm:@openai/codex\n",
			})),
			push: vi.fn(async () => OK),
		},
		commands: { run: vi.fn(async (cmd: string) => run(cmd)) },
		files: {
			write: vi.fn(async (path: string, data: string) => {
				store[path] = data;
			}),
			read: vi.fn(async (path: string) => store[path]),
		},
		kill: vi.fn(async () => {}),
	};
}

interface PrStub {
	number: number;
}
/** A fake installation Octokit with configurable PR/issue list responses. */
function makeOctokit(opts?: {
	closed?: PrStub[];
	open?: PrStub[];
	dashboard?: { html_url: string; pull_request?: unknown }[];
	compare?: {
		commits?: { sha: string }[];
		files?: { filename: string; patch: string }[];
	};
	branchExists?: boolean;
}) {
	const {
		closed = [],
		open = [],
		dashboard = [],
		compare = {
			commits: [{ sha: "deadbeef" }],
			files: [{ filename: "mise.toml", patch: "@@ -1 +1 @@\n+updated" }],
		},
		branchExists: existingBranch = open.length > 0,
	} = opts ?? {};
	return {
		rest: {
			git: {
				getRef: vi.fn(async ({ ref }: { ref: string }) => {
					if (ref === "heads/main") {
						return { data: { object: { sha: "base123" } } };
					}
					if (existingBranch) {
						return { data: { object: { sha: "oldbranch123" } } };
					}
					throw Object.assign(new Error("Not Found"), { status: 404 });
				}),
				getCommit: vi.fn(async () => ({
					data: { tree: { sha: "basetree123" } },
				})),
				createTree: vi.fn(async () => ({ data: { sha: "tree123" } })),
				createCommit: vi.fn(async () => ({ data: { sha: "commit123" } })),
				createRef: vi.fn(async () => ({
					data: { ref: `refs/heads/${BRANCH}` },
				})),
				updateRef: vi.fn(async () => ({
					data: { object: { sha: "commit123" } },
				})),
			},
			pulls: {
				list: vi.fn(async ({ state }: { state: string }) => ({
					data: state === "closed" ? closed : open,
				})),
				create: vi.fn(async () => ({ data: { number: 7 } })),
				update: vi.fn(async () => ({ data: { number: 7 } })),
			},
			issues: {
				listForRepo: vi.fn(async () => ({ data: dashboard })),
			},
			repos: {
				compareCommitsWithBasehead: vi.fn(async () => ({ data: compare })),
			},
		},
	};
}

const upgrade: SafeUpgrade = {
	manager: "mise",
	manifest: "mise.toml",
	package: "npm:@openai/codex",
	current: "0.63.0",
	target: "0.64.0",
	updateType: "minor",
};
const BRANCH = "uppy/mise-npm-openai-codex-0.64.0";

const astroAlpha: SafeUpgrade = {
	manager: "mise",
	manifest: "mise.toml",
	package: "npm:@astrojs/alpha",
	current: "1.0.0",
	target: "1.1.0",
	updateType: "minor",
	groupName: "Astro",
};
const astroBeta: SafeUpgrade = {
	manager: "mise",
	manifest: "mise.toml",
	package: "npm:@astrojs/beta",
	current: "2.0.0",
	target: "2.1.0",
	updateType: "minor",
	groupName: "Astro",
};
const GROUPED_BRANCH = safeUpgradeGroupBranch("mise", "Astro", [
	astroAlpha,
	astroBeta,
]);
const GROUPED_MISE_TOML =
	'[tools]\n"npm:@astrojs/alpha" = "1.0.0"\n"npm:@astrojs/beta" = "2.0.0"\n';

const params: UpgradeParams = {
	organization: "craftlions",
	repository: "website",
	defaultBranch: "main",
	installationId: 42,
	upgrades: [upgrade],
};
const groupedParams: UpgradeParams = {
	organization: "craftlions",
	repository: "website",
	defaultBranch: "main",
	installationId: 42,
	upgrades: [astroAlpha, astroBeta],
};
const spec = {
	editManifest: miseUpdateManifest,
	updateCommand: miseInstallCommand,
	commitMessage: miseCommitMessage,
};
const groupedSpec = {
	editManifest: miseUpdateManifest,
	updateCommand: miseInstallCommand,
	commitMessage: miseCommitMessage,
	commitMessageGrouped: miseCommitMessageGrouped,
};
const env = { E2B_API_KEY: "k" } as unknown as Env;

// Runs each `step.do` callback inline so assertions see the real sequence.
const step = {
	do: <T>(_name: string, cb: () => Promise<T>) => cb(),
} as unknown as WorkflowStep;

const ranCommands = (sandbox: ReturnType<typeof makeSandbox>): string[] =>
	sandbox.commands.run.mock.calls.map((call) => call[0] as string);

const updateCommands = (sandbox: ReturnType<typeof makeSandbox>): string[] =>
	ranCommands(sandbox);

beforeEach(() => {
	vi.clearAllMocks();
});

describe("renderPrBody", () => {
	const result = {
		commitSha: "abc",
		branch: BRANCH,
		diff: "+x\n",
		filesChanged: 1,
	};

	it("renders the structured table, diff, and dashboard link", () => {
		const body = renderPrBody([upgrade], result, "https://gh/issues/1");
		expect(body).toContain(
			"| Package | From | To | Manifest | Bump type |",
		);
		expect(body).toContain("| --- | --- | --- | --- | --- |");
		expect(body).toContain(
			"| `npm:@openai/codex` | `0.63.0` | `0.64.0` | `mise.toml` | minor |",
		);
		expect(body).toContain("[Dependency Dashboard](https://gh/issues/1)");
		expect(body).toContain("```diff");
	});

	it("omits the dashboard link when no issue url is given", () => {
		expect(renderPrBody([upgrade], result)).not.toContain("Dependency Dashboard");
	});

	it("renders multiple upgrades in one table", () => {
		const body = renderPrBody([astroAlpha, astroBeta], result);
		const headerCount = (body.match(/\| Package \| From \| To \| Manifest \| Bump type \|/g) ?? [])
			.length;
		expect(headerCount).toBe(1);
		expect(body).toContain(
			"| `npm:@astrojs/alpha` | `1.0.0` | `1.1.0` | `mise.toml` | minor |",
		);
		expect(body).toContain(
			"| `npm:@astrojs/beta` | `2.0.0` | `2.1.0` | `mise.toml` | minor |",
		);
	});
});

describe("normalizeUpgrades", () => {
	it("prefers the upgrades array when present", () => {
		expect(normalizeUpgrades({ ...params, upgrades: [upgrade] })).toEqual([
			upgrade,
		]);
	});

	it("falls back to the deprecated upgrade field when upgrades is missing", () => {
		const { upgrades: _, ...rest } = params;
		expect(
			normalizeUpgrades({ ...rest, upgrade } as unknown as UpgradeParams),
		).toEqual([upgrade]);
	});

	it("falls back to the deprecated upgrade field when upgrades is empty", () => {
		expect(normalizeUpgrades({ ...params, upgrades: [], upgrade })).toEqual([
			upgrade,
		]);
	});

	it("throws when neither upgrades nor upgrade is provided", () => {
		const { upgrades: _, upgrade: __, ...rest } = params;
		expect(() => normalizeUpgrades(rest as UpgradeParams)).toThrow(
			NonRetryableError,
		);
	});
});

describe("findDashboardIssue", () => {
	// A fake installation octokit exposing only `issues.listForRepo`, the one
	// call findDashboardIssue makes.
	const octokitWith = (data: unknown[]) =>
		({
			rest: { issues: { listForRepo: vi.fn(async () => ({ data })) } },
		}) as unknown as Parameters<typeof findDashboardIssue>[0];

	// Regression: https://github.com/craftlions/uppy/issues/10 — GitHub's REST
	// API returns pull requests as issues, and uppy's own upgrade PRs are newer
	// than the dashboard so they sort to index 0 under the default created-desc
	// order. The old code updated `data[0]`, clobbering a PR body instead of the
	// dashboard. The helper must skip anything with a `pull_request` field.
	it("skips a bot-authored PR and selects the dashboard issue", async () => {
		const octokit = octokitWith([
			{
				number: 42,
				title: "chore(deps): update npm:@openai/codex from 0.63.0 to 0.64.0",
				html_url: "https://github.com/craftlions/website/pull/42",
				pull_request: { url: "https://github.com/craftlions/website/pull/42" },
			},
			{
				number: 7,
				title: DASHBOARD_TITLE,
				html_url: "https://github.com/craftlions/website/issues/7",
			},
		]);

		const issue = await findDashboardIssue(octokit, "craftlions", "website");

		expect(issue?.number).toBe(7);
		expect(issue?.html_url).toBe(
			"https://github.com/craftlions/website/issues/7",
		);
	});

	it("returns undefined when only a bot-authored PR is open", async () => {
		const octokit = octokitWith([
			{
				number: 42,
				title: "chore(deps): update npm:@openai/codex from 0.63.0 to 0.64.0",
				html_url: "https://github.com/craftlions/website/pull/42",
				pull_request: { url: "https://github.com/craftlions/website/pull/42" },
			},
		]);

		await expect(
			findDashboardIssue(octokit, "craftlions", "website"),
		).resolves.toBeUndefined();
	});
});

describe("withSandbox", () => {
	it("creates from the template and kills after the callback resolves", async () => {
		h.sandbox = makeSandbox();
		const value = await withSandbox(
			env,
			{ envs: { GIT_TOKEN: "t" } },
			async () => 5,
		);
		expect(value).toBe(5);
		expect(vi.mocked(Sandbox.create)).toHaveBeenCalledWith(E2B_TEMPLATE, {
			apiKey: "k",
			envs: { GIT_TOKEN: "t" },
		});
		expect(
			(h.sandbox as ReturnType<typeof makeSandbox>).kill,
		).toHaveBeenCalled();
	});

	it("kills the sandbox even when the callback throws", async () => {
		const sandbox = makeSandbox();
		h.sandbox = sandbox;
		await expect(
			withSandbox(env, { envs: {} }, async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(sandbox.kill).toHaveBeenCalled();
	});
});

describe("mintInstallationToken", () => {
	it("returns the installation access token", async () => {
		await expect(mintInstallationToken(getApp(), 42, "website")).resolves.toBe(
			"tok-xyz",
		);
	});
});

describe("runManagerUpgrade", () => {
	it("opens a PR, signing off and pushing from a clean sandbox", async () => {
		const sandbox = makeSandbox();
		h.sandbox = sandbox;
		h.octokit = makeOctokit({ closed: [], open: [] });

		const result = await runManagerUpgrade(env, step, params, spec);

		expect(result).toMatchObject({
			commitSha: "deadbeef",
			branch: BRANCH,
			filesChanged: 1,
		});
		expect(h.createInstallationAccessToken).toHaveBeenCalledWith({
			installation_id: 42,
			repositories: ["website"],
		});
		expect(sandbox.git.configureUser).toHaveBeenCalledWith(BOT_NAME, BOT_EMAIL);
		expect(sandbox.git.dangerouslyAuthenticate).not.toHaveBeenCalled();
		expect(sandbox.git.clone).toHaveBeenCalledWith(
			"https://github.com/craftlions/website.git",
			expect.objectContaining({
				branch: "main",
				depth: 1,
				password: "tok-xyz",
				path: WORKSPACE,
				username: "x-access-token",
			}),
		);
		expect(sandbox.git.createBranch).toHaveBeenCalledWith(".", BRANCH, {
			cwd: WORKSPACE,
		});
		// mise edits mise.toml directly, preserving the full quoted backend key,
		// then trusts + installs to validate — it no longer calls `mise use`.
		expect(sandbox.files.write).toHaveBeenCalledWith(
			`${WORKSPACE}/mise.toml`,
			'[tools]\n"npm:@openai/codex" = "0.64.0"\n',
		);
		expect(updateCommands(sandbox)).toEqual(["mise trust -y && mise install"]);
		expect(updateCommands(sandbox)).not.toContain(
			"mise use npm:@openai/codex@0.64.0",
		);
		expect(sandbox.git.add).toHaveBeenCalledWith(".", {
			all: true,
			cwd: WORKSPACE,
		});
		expect(sandbox.git.commit).not.toHaveBeenCalled();
		expect(sandbox.git.push).not.toHaveBeenCalled();
		expect(sandbox.kill).toHaveBeenCalled();

		const octokit = h.octokit as ReturnType<typeof makeOctokit>;
		expect(octokit.rest.git.createTree).toHaveBeenCalledWith({
			owner: "craftlions",
			repo: "website",
			base_tree: "basetree123",
			tree: [
				{
					// The blob carries the edited manifest the sandbox wrote and read back.
					content: '[tools]\n"npm:@openai/codex" = "0.64.0"\n',
					mode: "100644",
					path: "mise.toml",
					type: "blob",
				},
			],
		});
		expect(octokit.rest.git.createCommit).toHaveBeenCalledWith(
			expect.objectContaining({
				author: { email: BOT_EMAIL, name: BOT_NAME },
				committer: { email: BOT_EMAIL, name: BOT_NAME },
				message: expect.stringContaining(
					`Signed-off-by: ${BOT_NAME} <${BOT_EMAIL}>`,
				),
				parents: ["base123"],
				tree: "tree123",
			}),
		);
		expect(octokit.rest.git.createRef).toHaveBeenCalledWith({
			owner: "craftlions",
			repo: "website",
			ref: `refs/heads/${BRANCH}`,
			sha: "commit123",
		});
		expect(octokit.rest.git.updateRef).not.toHaveBeenCalled();
		expect(octokit.rest.repos.compareCommitsWithBasehead).toHaveBeenCalledWith({
			owner: "craftlions",
			repo: "website",
			basehead: `main...${BRANCH}`,
		});
		expect(octokit.rest.pulls.update).not.toHaveBeenCalled();
		expect(octokit.rest.pulls.create).toHaveBeenCalledTimes(1);
		expect(octokit.rest.pulls.create).toHaveBeenCalledWith(
			expect.objectContaining({
				base: "main",
				head: BRANCH,
				title: "chore(deps): update npm:@openai/codex from 0.63.0 to 0.64.0",
			}),
		);
	});

	it("updates the existing open PR instead of opening a new one", async () => {
		h.sandbox = makeSandbox();
		h.octokit = makeOctokit({ closed: [], open: [{ number: 7 }] });

		await runManagerUpgrade(env, step, params, spec);

		const sandbox = h.sandbox as ReturnType<typeof makeSandbox>;
		expect(sandbox.git.clone).toHaveBeenCalledWith(
			"https://github.com/craftlions/website.git",
			expect.objectContaining({ branch: "main" }),
		);
		expect(sandbox.git.createBranch).toHaveBeenCalledWith(".", BRANCH, {
			cwd: WORKSPACE,
		});
		const octokit = h.octokit as ReturnType<typeof makeOctokit>;
		expect(octokit.rest.git.createRef).not.toHaveBeenCalled();
		expect(octokit.rest.git.updateRef).toHaveBeenCalledWith({
			owner: "craftlions",
			repo: "website",
			ref: `heads/${BRANCH}`,
			sha: "commit123",
			force: true,
		});
		expect(octokit.rest.pulls.create).not.toHaveBeenCalled();
		expect(octokit.rest.pulls.update).toHaveBeenCalledTimes(1);
		expect(octokit.rest.pulls.update).toHaveBeenCalledWith(
			expect.objectContaining({
				pull_number: 7,
			}),
		);
	});

	it("groups upgrades by groupName into a single branch/PR", async () => {
		const sandbox = makeSandbox({ miseToml: GROUPED_MISE_TOML });
		h.sandbox = sandbox;
		h.octokit = makeOctokit({ closed: [], open: [] });

		const result = await runManagerUpgrade(
			env,
			step,
			groupedParams,
			groupedSpec,
		);
		expect(result).toMatchObject({
			commitSha: "deadbeef",
			branch: GROUPED_BRANCH,
			filesChanged: 1,
		});
		expect(sandbox.git.createBranch).toHaveBeenCalledWith(".", GROUPED_BRANCH, {
			cwd: WORKSPACE,
		});
		expect(sandbox.files.write).toHaveBeenCalledWith(
			`${WORKSPACE}/mise.toml`,
			'[tools]\n"npm:@astrojs/alpha" = "1.1.0"\n"npm:@astrojs/beta" = "2.1.0"\n',
		);
		const octokit = h.octokit as ReturnType<typeof makeOctokit>;
		expect(octokit.rest.pulls.create).toHaveBeenCalledTimes(1);
		expect(octokit.rest.pulls.create).toHaveBeenCalledWith(
			expect.objectContaining({
				base: "main",
				head: GROUPED_BRANCH,
				title: "chore(deps): update Astro (npm:@astrojs/alpha, npm:@astrojs/beta)",
			}),
		);
	});

	it("short-circuits to no-op when a closed PR exists, never touching a sandbox", async () => {
		h.sandbox = makeSandbox();
		h.octokit = makeOctokit({ closed: [{ number: 3 }] });

		const result = await runManagerUpgrade(env, step, params, spec);

		expect(result).toBe("no-op");
		expect(vi.mocked(Sandbox.create)).not.toHaveBeenCalled();
		const octokit = h.octokit as ReturnType<typeof makeOctokit>;
		expect(octokit.rest.pulls.create).not.toHaveBeenCalled();
		expect(octokit.rest.pulls.update).not.toHaveBeenCalled();
	});

	it("fails without retrying on an empty diff", async () => {
		const sandbox = makeSandbox({ stagedCount: 0 });
		h.sandbox = sandbox;
		h.octokit = makeOctokit({ closed: [], open: [] });

		const error = await runManagerUpgrade(env, step, params, spec).catch(
			(caught: unknown) => caught,
		);

		expect(error).toBeInstanceOf(NonRetryableError);
		expect(error).toHaveProperty(
			"message",
			"update command produced no changes for npm:@openai/codex -> 0.64.0",
		);
		expect(sandbox.kill).toHaveBeenCalled();
		expect(sandbox.git.commit).not.toHaveBeenCalled();
		const octokit = h.octokit as ReturnType<typeof makeOctokit>;
		expect(octokit.rest.git.createCommit).not.toHaveBeenCalled();
		expect(octokit.rest.pulls.create).not.toHaveBeenCalled();
	});

	it("surfaces the stderr from a real thrown mise install failure and publishes no PR", async () => {
		// A non-zero `mise install` is a failed safe upgrade — e.g. the new release
		// would weaken `mise.lock` provenance. e2b throws `CommandExitError` on the
		// non-zero exit before uppy's manual handling runs, so without the catch the
		// failure surfaces as a context-free `CommandExitError: exit status 1`.
		const sandbox = makeSandbox({
			runImpl: () => {
				throw new h.CommandExitError({
					exitCode: 1,
					stderr:
						"mise ERROR github:endevco/aube@1.18.2: lockfile provenance github-attestations is missing from the new release",
					stdout: "mise trusted ~/workspace/mise.toml",
				});
			},
		});
		h.sandbox = sandbox;
		h.octokit = makeOctokit({ closed: [], open: [] });

		const error = await runManagerUpgrade(env, step, params, spec).catch(
			(caught: unknown) => caught,
		);

		// The bare `CommandExitError: exit status 1` is replaced by the rich,
		// stderr-bearing message; both stderr and stdout are surfaced.
		expect(error).toBeInstanceOf(Error);
		expect(error).toHaveProperty(
			"message",
			"update command failed (exit 1): mise ERROR github:endevco/aube@1.18.2: lockfile provenance github-attestations is missing from the new release\nmise trusted ~/workspace/mise.toml",
		);
		expect(sandbox.kill).toHaveBeenCalled();
		const octokit = h.octokit as ReturnType<typeof makeOctokit>;
		expect(octokit.rest.git.createCommit).not.toHaveBeenCalled();
		expect(octokit.rest.pulls.create).not.toHaveBeenCalled();
	});

	it("rethrows non-CommandExitError failures from the update command untouched", async () => {
		const boom = new Error("network down");
		const sandbox = makeSandbox({
			runImpl: () => {
				throw boom;
			},
		});
		h.sandbox = sandbox;
		h.octokit = makeOctokit({ closed: [], open: [] });

		await expect(runManagerUpgrade(env, step, params, spec)).rejects.toBe(boom);
		expect(sandbox.kill).toHaveBeenCalled();
	});
});
