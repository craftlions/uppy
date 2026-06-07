import type {
	Datasource,
	DependencyRef,
	VersionInfo,
} from "../src/datasource.ts";
import type { Dependency, ManagerDependencies } from "../src/deps.ts";
import { describe, expect, it } from "vitest";
import { type Manager, managerByName } from "../src/manager.ts";
import { fetchUpdateCheckForManager } from "../src/update-check.ts";

const AGED = "2024-01-01T00:00:00.000Z"; // 9 days before NOW → safe
const NOW = Date.parse("2024-01-10T00:00:00Z");

/** A safe minor bump from `ref` to `1.1.0` for any ref a datasource resolves. */
const bumpTo110 = (ref: string): VersionInfo => ({
	versions: [ref, "1.1.0"],
	times: { "1.1.0": AGED },
	latest: "1.1.0",
});

/**
 * Build a {@link import("../src/update-check.ts").DatasourceLookup} over a table
 * of `datasource name → (lookupName → VersionInfo)`. Records, per datasource, the
 * refs it was asked to resolve; datasource names absent from the table resolve to
 * `null` (unknown adapter). A datasource looks each ref up by its `name` (the
 * lookup name) and returns the info under the ref's `key`.
 */
function fakeLookups(table: Record<string, Record<string, VersionInfo>>): {
	lookup: (name: string) => Datasource | null;
	calls: Record<string, DependencyRef[]>;
} {
	const calls: Record<string, DependencyRef[]> = {};
	const lookup = (name: string): Datasource | null => {
		const entries = table[name];
		if (!entries) {
			return null;
		}
		return {
			lookup(refs: DependencyRef[]) {
				calls[name] = refs;
				const found = new Map<string, VersionInfo>();
				for (const ref of refs) {
					const info = entries[ref.name];
					if (info) {
						found.set(ref.key ?? ref.name, info);
					}
				}
				return Promise.resolve(found);
			},
		};
	};
	return { lookup, calls };
}

const manager = (name: string): Manager => {
	const found = managerByName(name);
	if (!found) {
		throw new Error(`no manager named ${name}`);
	}
	return found;
};

const group = (
	name: string,
	files: { file: string; dependencies: Dependency[] }[],
): ManagerDependencies => ({ manager: name, files });

describe("fetchUpdateCheckForManager", () => {
	it("routes npm dependencies through the manager's default datasource", async () => {
		const { lookup, calls } = fakeLookups({
			npm: {
				vitest: bumpTo110("1.0.0"),
				"@octokit/core": bumpTo110("1.0.0"),
			},
		});

		const updates = await fetchUpdateCheckForManager(
			group("npm", [
				{
					file: "package.json",
					dependencies: [
						{ name: "vitest", version: "1.0.0", depType: "devDependencies" },
						{
							name: "@octokit/core",
							version: "1.0.0",
							depType: "dependencies",
						},
					],
				},
			]),
			manager("npm"),
			lookup,
			{ now: NOW },
		);

		// One manager dependency group resolves to one merged update record, with
		// every dependency routed to the npm default datasource.
		expect(Object.keys(calls)).toEqual(["npm"]);
		expect(updates).toEqual({
			vitest: {
				current: "1.0.0",
				target: "1.1.0",
				updateType: "minor",
				state: "safe",
			},
			"@octokit/core": {
				current: "1.0.0",
				target: "1.1.0",
				updateType: "minor",
				state: "safe",
			},
		});
	});

	it("routes mise dependencies to multiple datasources within one manager", async () => {
		const { lookup, calls } = fakeLookups({
			core: { node: bumpTo110("1.0.0") },
			"github-releases": { "endevco/aube": bumpTo110("1.0.0") },
			aqua: { "aws/aws-cli": bumpTo110("1.0.0") },
			npm: { "@openai/codex": bumpTo110("1.0.0") },
		});

		const updates = await fetchUpdateCheckForManager(
			group("mise", [
				{
					file: "mise.toml",
					dependencies: [
						{
							name: "core:node",
							datasource: "core",
							lookupName: "node",
							version: "1.0.0",
						},
						{
							name: "github:endevco/aube",
							datasource: "github-releases",
							lookupName: "endevco/aube",
							version: "1.0.0",
						},
						{
							name: "aqua:aws/aws-cli",
							datasource: "aqua",
							lookupName: "aws/aws-cli",
							version: "1.0.0",
						},
						{
							name: "npm:@openai/codex",
							datasource: "npm",
							lookupName: "@openai/codex",
							version: "1.0.0",
						},
					],
				},
			]),
			manager("mise"),
			lookup,
			{ now: NOW },
		);

		// Every per-tool backend routed to its own datasource (mise has no default).
		expect(Object.keys(calls).sort()).toEqual([
			"aqua",
			"core",
			"github-releases",
			"npm",
		]);
		expect(updates).toMatchObject({
			"core:node": { target: "1.1.0" },
			"github:endevco/aube": { target: "1.1.0" },
			"aqua:aws/aws-cli": { target: "1.1.0" },
			"npm:@openai/codex": { target: "1.1.0" },
		});
	});

	it("starts the manager's datasource lookups in parallel", async () => {
		let releaseCore: (() => void) | undefined;
		const coreGate = new Promise<void>((resolve) => {
			releaseCore = resolve;
		});
		const started: string[] = [];

		const gatedDatasource = (
			name: string,
			gate: Promise<void>,
		): Datasource => ({
			async lookup(refs: DependencyRef[]) {
				started.push(name);
				await gate;
				return new Map(
					refs.map((ref) => [ref.key ?? ref.name, bumpTo110("1.0.0")]),
				);
			},
		});

		const pending = fetchUpdateCheckForManager(
			group("mise", [
				{
					file: "mise.toml",
					dependencies: [
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
				},
			]),
			manager("mise"),
			(name) =>
				gatedDatasource(name, name === "core" ? coreGate : Promise.resolve()),
			{ now: NOW },
		);

		// The npm lookup starts without waiting for the gated core lookup to finish.
		await Promise.resolve();
		expect(started).toEqual(["core", "npm"]);
		releaseCore?.();
		await expect(pending).resolves.toMatchObject({
			"core:node": { target: "1.1.0" },
			"npm:@openai/codex": { target: "1.1.0" },
		});
	});

	it("routes github-actions refs through the default github-tags datasource", async () => {
		const { lookup, calls } = fakeLookups({
			"github-tags": { "actions/checkout": bumpTo110("v1.0.0") },
		});

		const updates = await fetchUpdateCheckForManager(
			group("github-actions", [
				{
					file: ".github/workflows/ci.yml",
					dependencies: [
						{
							name: "actions/checkout",
							version: "v1.0.0",
							depType: "action",
						},
					],
				},
			]),
			manager("github-actions"),
			lookup,
			{ now: NOW },
		);

		expect(Object.keys(calls)).toEqual(["github-tags"]);
		// Actions key by `name@ref`, keeping the same action at different refs apart.
		expect(updates).toMatchObject({
			"actions/checkout@v1.0.0": { target: "1.1.0" },
		});
	});

	it("omits unsupported dependencies from datasource lookup", async () => {
		const { lookup, calls } = fakeLookups({
			core: { node: bumpTo110("1.0.0") },
		});

		const updates = await fetchUpdateCheckForManager(
			group("mise", [
				{
					file: "mise.toml",
					dependencies: [
						{
							name: "core:node",
							datasource: "core",
							lookupName: "node",
							version: "1.0.0",
						},
						{
							name: "node",
							version: "1.0.0",
							unsupportedReason:
								"mise shorthand is unsupported; use a full backend identifier",
						},
					],
				},
			]),
			manager("mise"),
			lookup,
			{ now: NOW },
		);

		// The unsupported shorthand never reaches a datasource; only core is queried.
		expect(Object.keys(calls)).toEqual(["core"]);
		expect(calls.core).toEqual([
			{ name: "node", ref: "1.0.0", key: "core:node" },
		]);
		expect(updates).toMatchObject({ "core:node": { target: "1.1.0" } });
	});

	it("skips an unknown datasource without failing the whole manager check", async () => {
		const { lookup, calls } = fakeLookups({
			core: { node: bumpTo110("1.0.0") },
			// `aqua` is intentionally absent → resolves to null (unknown adapter).
		});

		const updates = await fetchUpdateCheckForManager(
			group("mise", [
				{
					file: "mise.toml",
					dependencies: [
						{
							name: "core:node",
							datasource: "core",
							lookupName: "node",
							version: "1.0.0",
						},
						{
							name: "aqua:aws/aws-cli",
							datasource: "aqua",
							lookupName: "aws/aws-cli",
							version: "1.0.0",
						},
					],
				},
			]),
			manager("mise"),
			lookup,
			{ now: NOW },
		);

		// The known datasource still resolves; the unknown one contributes nothing.
		expect(Object.keys(calls)).toEqual(["core"]);
		expect(updates).toEqual({
			"core:node": {
				current: "1.0.0",
				target: "1.1.0",
				updateType: "minor",
				state: "safe",
			},
		});
	});
});
