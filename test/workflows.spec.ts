import { describe, expect, it } from "vitest";
import { safeUpgradeBranch } from "../src/workflows/branches.ts";

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
