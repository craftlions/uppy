import type { WorkflowStep } from "cloudflare:workers";
import type { SafeUpgrade } from "../../src/deps.ts";
import { NonRetryableError } from "cloudflare:workflows";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	miseCommitMessage,
	miseUpdateCommand,
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
		error?: string;
		constructor(result: {
			exitCode: number;
			stdout: string;
			stderr: string;
			error?: string;
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
	E2B_TEMPLATE,
	mintInstallationToken,
	renderPrBody,
	runManagerUpgrade,
	type UpgradeParams,
	WORKSPACE,
	withSandbox,
} from "../../src/workflows/sandbox.ts";

type Cmd = { exitCode: number; stdout: string; stderr: string };
const OK: Cmd = { exitCode: 0, stdout: "", stderr: "" };

/** A fake e2b sandbox: git/commands/files/kill spies with sane SDK results. */
function makeSandbox(opts?: {
	runImpl?: (cmd: string) => Cmd;
	stagedCount?: number;
}) {
	const store: Record<string, string> = {};
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

const params: UpgradeParams = {
	organization: "craftlions",
	repository: "website",
	defaultBranch: "main",
	installationId: 42,
	upgrade,
};
const spec = {
	updateCommand: miseUpdateCommand,
	commitMessage: miseCommitMessage,
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

	it("renders the structured header, diff, and dashboard link", () => {
		const body = renderPrBody(upgrade, result, "https://gh/issues/1");
		expect(body).toContain("| Package | `npm:@openai/codex` |");
		expect(body).toContain("| From | `0.63.0` |");
		expect(body).toContain("| To | `0.64.0` |");
		expect(body).toContain("| Manifest | `mise.toml` |");
		expect(body).toContain("| Bump type | minor |");
		expect(body).toContain("[Dependency Dashboard](https://gh/issues/1)");
		expect(body).toContain("```diff");
	});

	it("omits the dashboard link when no issue url is given", () => {
		expect(renderPrBody(upgrade, result)).not.toContain("Dependency Dashboard");
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
		expect(sandbox.git.dangerouslyAuthenticate).toHaveBeenCalledWith({
			username: "x-access-token",
			password: "tok-xyz",
		});
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
		expect(updateCommands(sandbox)).toEqual([
			"mise use npm:@openai/codex@0.64.0",
		]);
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
					content: "",
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
		expect(octokit.rest.pulls.create.mock.calls[0][0]).toMatchObject({
			base: "main",
			head: BRANCH,
			title: "chore(deps): update npm:@openai/codex from 0.63.0 to 0.64.0",
		});
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
		expect(octokit.rest.pulls.update.mock.calls[0][0]).toMatchObject({
			pull_number: 7,
		});
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

	it("surfaces the stderr from a thrown CommandExitError, labelled with the failing operation", async () => {
		const sandbox = makeSandbox({
			runImpl: () => {
				throw new h.CommandExitError({
					exitCode: 1,
					stderr: "mise: config file is not trusted",
					stdout: "resolving npm:@openai/codex",
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
			"update command failed (exit 1): mise: config file is not trusted\nresolving npm:@openai/codex",
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
