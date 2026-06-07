import type { SafeUpgrade } from "../../src/deps.ts";
import { describe, expect, it } from "vitest";
import { npmCommitMessage, npmUpdateCommand } from "../../src/managers/npm.ts";

const base: SafeUpgrade = {
	manager: "npm",
	manifest: "package.json",
	package: "@octokit/core",
	current: "7.0.5",
	target: "7.0.6",
	updateType: "patch",
	depType: "dependencies",
};

describe("npmUpdateCommand", () => {
	it("wraps `aube add` in a hermetic mise exec", () => {
		expect(npmUpdateCommand(base)).toBe(
			"mise --no-config --no-env --no-hooks exec aube@latest node@latest -- aube add @octokit/core@7.0.6",
		);
	});

	it("appends --dev only for devDependencies", () => {
		expect(npmUpdateCommand({ ...base, depType: "devDependencies" })).toBe(
			"mise --no-config --no-env --no-hooks exec aube@latest node@latest -- aube add @octokit/core@7.0.6 --dev",
		);
		expect(
			npmUpdateCommand({ ...base, depType: "dependencies" }),
		).not.toContain("--dev");
	});
});

describe("npmCommitMessage", () => {
	it("renders the structured chore(deps) subject", () => {
		expect(npmCommitMessage(base)).toBe(
			"chore(deps): update @octokit/core from 7.0.5 to 7.0.6",
		);
	});
});
