import { describe, expect, it } from "vitest";
import {
	safeUpgradeBranch,
	safeUpgradeGroupBranch,
} from "../src/workflows/branches.ts";
import {
	DEFERRED_MANAGERS,
	MANAGER_WORKFLOW_BINDINGS,
	managerWorkflowBinding,
} from "../src/workflows/dispatch.ts";

describe("safeUpgradeBranch", () => {
	it("sanitizes backend-qualified mise package names into valid branch segments", () => {
		expect(
			safeUpgradeBranch({
				manager: "mise",
				manifest: "mise.toml",
				package: "npm:@openai/codex",
				current: "0.63.0",
				target: "0.64.0",
				updateType: "minor",
			}),
		).toBe("uppy/mise-npm-openai-codex-0.64.0");

		expect(
			safeUpgradeBranch({
				manager: "mise",
				manifest: "mise.toml",
				package: "github:endevco/aube",
				current: "1.17.1",
				target: "1.18.0",
				updateType: "minor",
			}),
		).toBe("uppy/mise-github-endevco-aube-1.18.0");
	});
});

describe("safeUpgradeGroupBranch", () => {
	it("builds a deterministic branch from manager, group name and package set", () => {
		const first = safeUpgradeGroupBranch("npm", "Astro", [
			{
				manager: "npm",
				manifest: "package.json",
				package: "astro",
				current: "1.0.0",
				target: "1.1.0",
				updateType: "minor",
			},
			{
				manager: "npm",
				manifest: "package.json",
				package: "@astrojs/rss",
				current: "1.0.0",
				target: "1.1.0",
				updateType: "minor",
			},
		]);
		const second = safeUpgradeGroupBranch("npm", "Astro", [
			{
				manager: "npm",
				manifest: "package.json",
				package: "@astrojs/rss",
				current: "1.0.0",
				target: "1.1.0",
				updateType: "minor",
			},
			{
				manager: "npm",
				manifest: "package.json",
				package: "astro",
				current: "1.0.0",
				target: "1.1.0",
				updateType: "minor",
			},
		]);
		expect(first).toBe(second);
		expect(first).toMatch(/^uppy\/npm-group-Astro-[a-f0-9]{7}$/);
	});
});

describe("managerWorkflowBinding", () => {
	it("routes each Manager to its own Workflow binding", () => {
		expect(managerWorkflowBinding("mise")).toBe("MISE_WORKFLOW");
		expect(managerWorkflowBinding("npm")).toBe("NPM_WORKFLOW");
		expect(managerWorkflowBinding("github-actions")).toBe(
			"GITHUB_ACTIONS_WORKFLOW",
		);
	});

	it("throws on an unmapped Manager so a typo is caught at the seam", () => {
		expect(() => managerWorkflowBinding("cargo")).toThrow(/cargo/);
	});

	it("defers github-actions but still maps it", () => {
		expect(DEFERRED_MANAGERS.has("github-actions")).toBe(true);
		expect(DEFERRED_MANAGERS.has("mise")).toBe(false);
		expect("github-actions" in MANAGER_WORKFLOW_BINDINGS).toBe(true);
	});
});
