import type { Datasource, DependencyRef } from "../src/datasource.ts";
import { describe, expect, it } from "vitest";
import { safeUpgradeBranch } from "../src/workflows/branches.ts";
import { fetchUpdatesByDatasource } from "../src/workflows/updates.ts";

const AGED = "2024-01-01T00:00:00.000Z";
const NOW = Date.parse("2024-01-10T00:00:00Z");

function delayedDatasource(
	started: string[],
	name: string,
	resolveAfter: Promise<void>,
): Datasource {
	return {
		async lookup(refs: DependencyRef[]) {
			started.push(name);
			await resolveAfter;
			return new Map(
				refs.map((ref) => [
					ref.key ?? ref.name,
					{
						versions: [ref.ref, "1.1.0"],
						times: { "1.1.0": AGED },
						latest: "1.1.0",
					},
				]),
			);
		},
	};
}

describe("safeUpgradeBranch", () => {
	it("sanitizes backend-qualified mise package names into valid branch segments", () => {
		expect(
			safeUpgradeBranch({
				ecosystem: "mise",
				manifest: "mise.toml",
				package: "npm:@openai/codex",
				current: "0.63.0",
				target: "0.64.0",
				updateType: "minor",
			}),
		).toBe("uppy/mise-npm-openai-codex-0.64.0");

		expect(
			safeUpgradeBranch({
				ecosystem: "mise",
				manifest: "mise.toml",
				package: "github:endevco/aube",
				current: "1.17.1",
				target: "1.18.0",
				updateType: "minor",
			}),
		).toBe("uppy/mise-github-endevco-aube-1.18.0");
	});
});

describe("fetchUpdatesByDatasource", () => {
	it("starts per-datasource lookups in parallel", async () => {
		let releaseFirstDatasource: (() => void) | undefined;
		const firstDatasource = new Promise<void>((resolve) => {
			releaseFirstDatasource = resolve;
		});
		const started: string[] = [];

		const pending = fetchUpdatesByDatasource(
			[
				{
					name: "core:node",
					datasource: "core",
					lookupName: "node",
					version: "1.0.0",
				},
				{
					name: "npm:@openai/codex",
					datasource: "npm",
					lookupName: "@openai/codex",
					version: "1.0.0",
				},
			],
			undefined,
			(name) =>
				delayedDatasource(
					started,
					name,
					name === "core" ? firstDatasource : Promise.resolve(),
				),
			{ now: NOW },
		);

		await Promise.resolve();
		expect(started).toEqual(["core", "npm"]);
		releaseFirstDatasource?.();
		await expect(pending).resolves.toMatchObject({
			"core:node": { target: "1.1.0" },
			"npm:@openai/codex": { target: "1.1.0" },
		});
	});
});
