import type { SafeUpgrade } from "../../src/deps.ts";
import { describe, expect, it } from "vitest";
import {
	miseCommitMessage,
	miseUpdateCommand,
} from "../../src/managers/mise.ts";

const upgrade: SafeUpgrade = {
	manager: "mise",
	manifest: "mise.toml",
	package: "npm:@openai/codex",
	current: "0.63.0",
	target: "0.64.0",
	updateType: "minor",
};

describe("miseUpdateCommand", () => {
	it("uses the full backend identity at the repo root", () => {
		expect(miseUpdateCommand(upgrade)).toBe(
			"mise use npm:@openai/codex@0.64.0",
		);
	});
});

describe("miseCommitMessage", () => {
	it("keeps the full mise id in the chore(deps) subject", () => {
		expect(miseCommitMessage(upgrade)).toBe(
			"chore(deps): update npm:@openai/codex from 0.63.0 to 0.64.0",
		);
	});
});
