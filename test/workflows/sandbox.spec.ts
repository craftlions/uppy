import type { WorkflowStep } from "cloudflare:workers";
import type { SafeUpgrade } from "../../src/deps.ts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	miseCommitMessage,
	miseUpdateCommand,
} from "../../src/managers/mise.ts";

// Shared mutable state the import-level mocks read from. Each test assigns a
// fresh fake octokit / sandbox before driving the workflow.
const h = vi.hoisted(() => ({
	sandbox: null as unknown,
	octokit: null as unknown,
}));

vi.mock("e2b", () => ({
	Sandbox: { create: vi.fn(async () => h.sandbox) },
}));

vi.mock("../../src/github.ts", () => ({
	getApp: () => ({
		getInstallationOctokit: async () => h.octokit,
		octokit: {
			rest: {
				apps: {
					createInstallationAccessToken: async () => ({
						data: { token: "tok-xyz" },
					}),
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
	withSandbox,
} from "../../src/workflows/sandbox.ts";

type Cmd = { exitCode: number; stdout: string; stderr: string };
const OK: Cmd = { exitCode: 0, stdout: "", stderr: "" };

/** A fake e2b sandbox: git/commands/files/kill spies with sane git stdout. */
function makeSandbox(runImpl?: (cmd: string) => Cmd) {
	const store: Record<string, string> = {};
	const run =
		runImpl ??
		((cmd: string): Cmd => {
			if (cmd.includes("--name-only")) {
				return { ...OK, stdout: "mise.toml\n" };
			}
			if (cmd.includes("git diff --cached")) {
				return { ...OK, stdout: "+updated\n" };
			}
			if (cmd.includes("rev-parse HEAD")) {
				return { ...OK, stdout: "deadbeef\n" };
			}
			return OK;
		});
	return {
		git: {
			configureUser: vi.fn(async () => OK),
			clone: vi.fn(async () => OK),
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
}) {
	const { closed = [], open = [], dashboard = [] } = opts ?? {};
	return {
		rest: {
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
	installationToken: "tok",
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
		await expect(mintInstallationToken(getApp(), 42)).resolves.toBe("tok-xyz");
	});
});

describe("runManagerUpgrade", () => {
	it("opens a PR, signing off and force-pushing from a clean sandbox", async () => {
		const sandbox = makeSandbox();
		h.sandbox = sandbox;
		h.octokit = makeOctokit({ closed: [], open: [] });

		const result = await runManagerUpgrade(env, step, params, spec);

		expect(result).toMatchObject({
			commitSha: "deadbeef",
			branch: BRANCH,
			filesChanged: 1,
		});
		expect(sandbox.git.configureUser).toHaveBeenCalledWith(BOT_NAME, BOT_EMAIL);
		expect(sandbox.git.clone).toHaveBeenCalledWith(
			"https://github.com/craftlions/website.git",
			{ path: "/workspace" },
		);
		const cmds = ranCommands(sandbox);
		expect(cmds).toEqual(
			expect.arrayContaining([
				expect.stringContaining("mise use npm:@openai/codex@0.64.0"),
				expect.stringContaining("commit --signoff"),
				expect.stringContaining("--force-with-lease"),
			]),
		);
		expect(sandbox.kill).toHaveBeenCalled();

		const octokit = h.octokit as ReturnType<typeof makeOctokit>;
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

		const octokit = h.octokit as ReturnType<typeof makeOctokit>;
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

	it("fails loudly on an empty diff and still kills the sandbox", async () => {
		const sandbox = makeSandbox((cmd) =>
			cmd.includes("--name-only") ? { ...OK, stdout: "" } : OK,
		);
		h.sandbox = sandbox;
		h.octokit = makeOctokit({ closed: [], open: [] });

		await expect(runManagerUpgrade(env, step, params, spec)).rejects.toThrow(
			/no changes/,
		);
		expect(sandbox.kill).toHaveBeenCalled();
		const octokit = h.octokit as ReturnType<typeof makeOctokit>;
		expect(octokit.rest.pulls.create).not.toHaveBeenCalled();
	});
});
