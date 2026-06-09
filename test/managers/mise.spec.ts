import type { SafeUpgrade } from "../../src/deps.ts";
import { describe, expect, it } from "vitest";
import {
	miseCommitMessage,
	miseInstallCommand,
	miseUpdateManifest,
} from "../../src/managers/mise.ts";

const upgrade: SafeUpgrade = {
	manager: "mise",
	manifest: "mise.toml",
	package: "npm:@openai/codex",
	current: "0.63.0",
	target: "0.64.0",
	updateType: "minor",
};

const upgradeFor = (
	pkg: string,
	current: string,
	target: string,
): SafeUpgrade => ({
	manager: "mise",
	manifest: "mise.toml",
	package: pkg,
	current,
	target,
	updateType: "minor",
});

describe("miseUpdateManifest", () => {
	it("rewrites the [tools] version in place", () => {
		const content = '[tools]\n"npm:@openai/codex" = "0.63.0"\n';
		expect(miseUpdateManifest(content, upgrade)).toBe(
			'[tools]\n"npm:@openai/codex" = "0.64.0"\n',
		);
	});

	it.each([
		['"core:node"', "core:node", "26.3.0", "26.4.0"],
		['"github:endevco/aube"', "github:endevco/aube", "1.18.0", "1.18.2"],
		['"aqua:aws/aws-cli"', "aqua:aws/aws-cli", "2.1.0", "2.2.0"],
		['"npm:@openai/codex"', "npm:@openai/codex", "0.63.0", "0.64.0"],
	])("preserves the full, quoted backend key %s", (key, pkg, current, target) => {
		const content = `[tools]\n${key} = "${current}"\n`;
		const out = miseUpdateManifest(content, upgradeFor(pkg, current, target));
		// The exact quoted key survives — `mise use` would have rewritten
		// `"core:node"` to bare `node` and broken the backend identity contract.
		expect(out).toBe(`[tools]\n${key} = "${target}"\n`);
	});

	it("touches only the matching entry, leaving the rest of mise.toml intact", () => {
		const content = [
			"[tools]",
			'"core:node" = "26.3.0"',
			'"github:endevco/aube" = "1.18.0"',
			"",
			"[settings]",
			"paranoid = true",
			"",
		].join("\n");
		const out = miseUpdateManifest(
			content,
			upgradeFor("github:endevco/aube", "1.18.0", "1.18.2"),
		);
		expect(out).toBe(
			[
				"[tools]",
				'"core:node" = "26.3.0"',
				'"github:endevco/aube" = "1.18.2"',
				"",
				"[settings]",
				"paranoid = true",
				"",
			].join("\n"),
		);
	});

	it("rewrites only the version of an inline-table entry, keeping its options and comment", () => {
		const content =
			'[tools]\n  "npm:foo" = { version = "1.2.3", os = ["linux"] } # pinned\n';
		expect(
			miseUpdateManifest(content, upgradeFor("npm:foo", "1.2.3", "1.3.0")),
		).toBe(
			'[tools]\n  "npm:foo" = { version = "1.3.0", os = ["linux"] } # pinned\n',
		);
	});

	it("throws when no [tools] entry matches the upgrade", () => {
		const content = '[tools]\n"core:node" = "26.3.0"\n';
		expect(() =>
			miseUpdateManifest(content, upgradeFor("npm:missing", "1.0.0", "2.0.0")),
		).toThrow("no [tools] entry for npm:missing in mise.toml");
	});
});

describe("miseInstallCommand", () => {
	it("trusts the cloned config, then installs to validate and refresh the lockfile", () => {
		expect(miseInstallCommand(upgrade)).toBe("mise trust -y && mise install");
	});
});

describe("miseCommitMessage", () => {
	it("keeps the full mise id in the chore(deps) subject", () => {
		expect(miseCommitMessage(upgrade)).toBe(
			"chore(deps): update npm:@openai/codex from 0.63.0 to 0.64.0",
		);
	});
});
