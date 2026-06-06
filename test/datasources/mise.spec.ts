import { afterEach, describe, expect, it, vi } from "vitest";
import {
	fetchOutdatedMise,
	fetchVersionsMise,
	parseVersionsTomlMise,
} from "../../src/datasources/mise.ts";

const NOW = Date.parse("2024-01-10T00:00:00Z");
const AGED = "2024-01-01T00:00:00.000Z"; // 9 days old → safe
const FRESH = "2024-01-09T00:00:00.000Z"; // 1 day old → too fresh

/** Build a `docs/<tool>.toml` body from version → timestamp entries. */
const toml = (entries: Record<string, string>): string =>
	`[versions]\n${Object.entries(entries)
		.map(
			([version, createdAt]) =>
				`"${version}" = { created_at = ${createdAt}, release_url = "https://example.test/${version}" }`,
		)
		.join("\n")}\n`;

/** Stub global fetch to serve a toml body per tool name, or 404 otherwise. */
function stubFetch(tomls: Record<string, string>): ReturnType<typeof vi.fn> {
	const fetchMock = vi.fn((input: string) => {
		const name = new URL(input).pathname
			.split("/")
			.at(-1)
			?.replace(/\.toml$/, "");
		const body = name ? tomls[name] : undefined;
		if (body === undefined) {
			return Promise.resolve(new Response("Not Found", { status: 404 }));
		}
		return Promise.resolve(new Response(body, { status: 200 }));
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("parseVersionsTomlMise", () => {
	it("reads versions and their created_at timestamps from the versions table", () => {
		const content = toml({ "1.0.0": AGED, "1.1.0": FRESH });
		expect(parseVersionsTomlMise(content)).toEqual({
			versions: ["1.0.0", "1.1.0"],
			times: { "1.0.0": AGED, "1.1.0": FRESH },
		});
	});

	it("parses entries that omit the optional release_url (e.g. node)", () => {
		const content = `[versions]\n"26.3.0" = { created_at = ${AGED} }\n`;
		expect(parseVersionsTomlMise(content)).toEqual({
			versions: ["26.3.0"],
			times: { "26.3.0": AGED },
		});
	});

	it("ignores comments and lines outside the versions table", () => {
		const content = `# a comment\n[meta]\nfoo = "bar"\n[versions]\n"1.0.0" = { created_at = ${AGED} }\n`;
		expect(parseVersionsTomlMise(content)).toEqual({
			versions: ["1.0.0"],
			times: { "1.0.0": AGED },
		});
	});

	it("skips malformed lines inside the versions table", () => {
		const content = `[versions]\nnot a version entry\n"1.0.0" = { created_at = ${AGED} }\n`;
		expect(parseVersionsTomlMise(content)).toEqual({
			versions: ["1.0.0"],
			times: { "1.0.0": AGED },
		});
	});
});

describe("fetchVersionsMise", () => {
	it("fetches and parses the docs toml for a tool", async () => {
		const fetchMock = stubFetch({ aube: toml({ "1.0.0": AGED }) });
		await expect(fetchVersionsMise("aube")).resolves.toEqual({
			versions: ["1.0.0"],
			times: { "1.0.0": AGED },
		});
		expect(fetchMock).toHaveBeenCalledWith(
			"https://raw.githubusercontent.com/jdx/mise-versions/main/docs/aube.toml",
		);
	});

	it("returns null when the tool has no docs toml", async () => {
		stubFetch({});
		await expect(fetchVersionsMise("ghost")).resolves.toBeNull();
	});

	it("returns null when the request throws", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.reject(new Error("network"))),
		);
		await expect(fetchVersionsMise("aube")).resolves.toBeNull();
	});
});

describe("fetchOutdatedMise", () => {
	it("classifies each tool by minimum release age and skips unknown tools", async () => {
		stubFetch({
			"safe-tool": toml({ "1.0.0": AGED, "1.1.0": AGED }),
			"newer-held-tool": toml({ "1.0.0": AGED, "1.1.0": AGED, "1.2.0": FRESH }),
			"held-tool": toml({ "1.0.0": AGED, "1.1.0": FRESH }),
			"current-tool": toml({ "2.0.0": AGED }),
		});

		const updates = await fetchOutdatedMise(
			[
				{ name: "safe-tool", version: "1.0.0" },
				{ name: "newer-held-tool", version: "1.0.0" },
				{ name: "held-tool", version: "1.0.0" },
				{ name: "current-tool", version: "2.0.0" },
				{ name: "ghost", version: "1.0.0" },
			],
			{ now: NOW },
		);

		expect(updates).toEqual({
			"safe-tool": {
				current: "1.0.0",
				target: "1.1.0",
				updateType: "minor",
				state: "safe",
			},
			"newer-held-tool": {
				current: "1.0.0",
				target: "1.1.0",
				updateType: "minor",
				state: "safe-newer-held",
				heldVersion: "1.2.0",
			},
			"held-tool": {
				current: "1.0.0",
				target: null,
				updateType: "minor",
				state: "held",
				heldVersion: "1.1.0",
			},
		});
	});

	it("ignores prereleases newer than the latest stable for a stable current", async () => {
		stubFetch({
			tool: toml({ "1.0.0": AGED, "1.1.0": AGED, "2.0.0-rc.1": AGED }),
		});

		const updates = await fetchOutdatedMise(
			[{ name: "tool", version: "1.0.0" }],
			{
				now: NOW,
			},
		);

		expect(updates).toEqual({
			tool: {
				current: "1.0.0",
				target: "1.1.0",
				updateType: "minor",
				state: "safe",
			},
		});
	});

	it("tolerates non-semver version entries when deriving the latest stable", async () => {
		stubFetch({
			tool: toml({ nightly: AGED, "1.0.0": AGED, "1.1.0": AGED }),
		});

		const updates = await fetchOutdatedMise(
			[{ name: "tool", version: "1.0.0" }],
			{
				now: NOW,
			},
		);

		expect(updates).toEqual({
			tool: {
				current: "1.0.0",
				target: "1.1.0",
				updateType: "minor",
				state: "safe",
			},
		});
	});
});
