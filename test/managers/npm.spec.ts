import type { SafeUpgrade } from "../../src/deps.ts";
import { describe, expect, it } from "vitest";
import {
	npmCommitMessage,
	npmCommitMessageGrouped,
	npmUpdateCommand,
	npmUpdateCommandGrouped,
} from "../../src/managers/npm.ts";

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

	it("appends -D only for devDependencies", () => {
		expect(npmUpdateCommand({ ...base, depType: "devDependencies" })).toBe(
			"mise --no-config --no-env --no-hooks exec aube@latest node@latest -- aube add @octokit/core@7.0.6 -D",
		);
		expect(
			npmUpdateCommand({ ...base, depType: "dependencies" }),
		).not.toContain(" -D");
	});
});

describe("npmCommitMessage", () => {
	it("renders the structured chore(deps) subject", () => {
		expect(npmCommitMessage(base)).toBe(
			"chore(deps): update @octokit/core from 7.0.5 to 7.0.6",
		);
	});
});

describe("npmUpdateCommandGrouped", () => {
	it("chains aube add commands for every package", () => {
		expect(
			npmUpdateCommandGrouped([
				base,
				{ ...base, package: "vitest", depType: "devDependencies" },
			]),
		).toBe(
			"mise --no-config --no-env --no-hooks exec aube@latest node@latest -- aube add @octokit/core@7.0.6 && mise --no-config --no-env --no-hooks exec aube@latest node@latest -- aube add vitest@7.0.6 -D",
		);
	});

	it("throws when upgrades is empty", () => {
		expect(() => npmUpdateCommandGrouped([])).toThrow(
			"npmUpdateCommandGrouped requires at least one upgrade",
		);
	});

	it("throws when upgrades is undefined", () => {
		expect(() => npmUpdateCommandGrouped(undefined as unknown as SafeUpgrade[])).toThrow(
			"npmUpdateCommandGrouped requires at least one upgrade",
		);
	});
});

describe("npmCommitMessageGrouped", () => {
	it("includes the group name and every package", () => {
		expect(
			npmCommitMessageGrouped([
				{ ...base, groupName: "MyGroup" },
				{ ...base, package: "vitest", groupName: "MyGroup" },
			]),
		).toBe("chore(deps): update MyGroup (@octokit/core, vitest)");
	});

	it("falls back to a plain package list when groupName is missing", () => {
		expect(npmCommitMessageGrouped([base, { ...base, package: "vitest" }])).toBe(
			"chore(deps): update @octokit/core, vitest",
		);
	});

	it("falls back when groupName values are inconsistent", () => {
		expect(
			npmCommitMessageGrouped([
				{ ...base, groupName: "MyGroup" },
				{ ...base, package: "vitest", groupName: "Other" },
			]),
		).toBe("chore(deps): update @octokit/core, vitest");
	});
});
