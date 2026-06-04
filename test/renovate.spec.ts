import type { ContentReader } from "../src/deps.ts";
import { describe, expect, it, vi } from "vitest";
import {
	detectRenovateConfig,
	mergeRenovatePresetConfig,
	osvVulnerabilityAlertsEnabled,
	parseRenovateConfig,
	RENOVATE_CONFIG_PATHS,
	unknownRenovateConfigOptions,
	vulnerabilityAlertsEnabled,
} from "../src/renovate.ts";

/** Build a mocked Octokit whose getContent serves base64 file fixtures. */
function mockReader(files: Record<string, string>): {
	octokit: ContentReader;
	getContent: ReturnType<typeof vi.fn>;
} {
	const getContent = vi.fn(({ path }: { path: string }) => {
		const content = files[path];
		if (content === undefined) {
			return Promise.reject(new Error("Not Found"));
		}
		return Promise.resolve({
			data: { type: "file", content: btoa(content) },
		});
	});
	return { octokit: { rest: { repos: { getContent } } }, getContent };
}

describe("parseRenovateConfig", () => {
	it("parses a .json file as JSONC (comments and trailing commas allowed)", () => {
		const result = parseRenovateConfig(
			'{ // managed by us\n "extends": ["config:recommended"], }',
			"renovate.json",
		);
		expect(result).toEqual({
			ok: true,
			data: { extends: ["config:recommended"] },
		});
	});

	it("parses a .json5 file as JSON5 (single quotes, unquoted keys)", () => {
		const result = parseRenovateConfig(
			"{ extends: ['config:recommended'] }",
			"renovate.json5",
		);
		expect(result).toEqual({
			ok: true,
			data: { extends: ["config:recommended"] },
		});
	});

	it("merges the :enableVulnerabilityAlerts preset from extends", () => {
		const result = parseRenovateConfig(
			"{ extends: ['config:recommended', ':enableVulnerabilityAlerts'] }",
			"renovate.json5",
		);
		expect(result).toEqual({
			ok: true,
			data: {
				extends: ["config:recommended"],
				vulnerabilityAlerts: { enabled: true },
			},
		});
	});

	it("lets explicit vulnerabilityAlerts config override preset values", () => {
		const result = parseRenovateConfig(
			"{ extends: [':enableVulnerabilityAlerts'], vulnerabilityAlerts: { enabled: false } }",
			"renovate.json5",
		);
		expect(result).toEqual({
			ok: true,
			data: {
				vulnerabilityAlerts: { enabled: false },
			},
		});
	});

	it("parses the extension-less .renovaterc as JSONC", () => {
		const result = parseRenovateConfig('{ "a": 1 }', ".renovaterc");
		expect(result).toEqual({ ok: true, data: { a: 1 } });
	});

	it("returns an error for invalid syntax instead of throwing", () => {
		const result = parseRenovateConfig("{ not valid", "renovate.json");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.message).toContain("renovate.json");
		}
	});

	it("returns an error when the top level is not an object", () => {
		const result = parseRenovateConfig("[1, 2, 3]", "renovate.json");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.message).toContain("must be a JSON object");
		}
	});
});

describe("unknownRenovateConfigOptions", () => {
	it("returns top-level config options that are not handled by the parser", () => {
		expect(
			unknownRenovateConfigOptions({
				$schema: "https://docs.renovatebot.com/renovate-schema.json",
				extends: ["config:recommended"],
				ignoreUnstable: false,
				osvVulnerabilityAlerts: true,
				packageRules: [],
				timezone: "UTC",
				vulnerabilityAlerts: { enabled: true },
			}),
		).toEqual(["packageRules", "timezone"]);
	});
});

describe("mergeRenovatePresetConfig", () => {
	it("supports a string extends value", () => {
		expect(
			mergeRenovatePresetConfig({
				extends: ":enableVulnerabilityAlerts",
			}),
		).toEqual({
			vulnerabilityAlerts: { enabled: true },
		});
	});
});

describe("osvVulnerabilityAlertsEnabled", () => {
	it("enables OSV checks only when the option is true", () => {
		expect(
			osvVulnerabilityAlertsEnabled({ osvVulnerabilityAlerts: true }),
		).toBe(true);
		expect(
			osvVulnerabilityAlertsEnabled({ osvVulnerabilityAlerts: false }),
		).toBe(false);
		expect(osvVulnerabilityAlertsEnabled({})).toBe(false);
	});
});

describe("vulnerabilityAlertsEnabled", () => {
	it("enables GitHub checks only when vulnerabilityAlerts.enabled is true", () => {
		expect(
			vulnerabilityAlertsEnabled({ vulnerabilityAlerts: { enabled: true } }),
		).toBe(true);
		expect(
			vulnerabilityAlertsEnabled({ vulnerabilityAlerts: { enabled: false } }),
		).toBe(false);
		expect(vulnerabilityAlertsEnabled({})).toBe(false);
	});
});

describe("detectRenovateConfig", () => {
	it("returns data:null when no config exists anywhere", async () => {
		const { octokit, getContent } = mockReader({});
		const result = await detectRenovateConfig(octokit, "acme", "repo");
		expect(result).toEqual({ ok: true, data: null });
		// every candidate path is probed before giving up
		expect(getContent).toHaveBeenCalledTimes(RENOVATE_CONFIG_PATHS.length);
	});

	it("returns the first matching config with its path", async () => {
		const { octokit } = mockReader({
			"renovate.json5": "{ extends: ['config:recommended'] }",
		});
		const result = await detectRenovateConfig(octokit, "acme", "repo");
		expect(result).toEqual({
			ok: true,
			data: {
				path: "renovate.json5",
				config: { extends: ["config:recommended"] },
			},
		});
	});

	it("stops at the first match and does not read later locations", async () => {
		const { octokit, getContent } = mockReader({
			"renovate.json": '{ "a": 1 }',
			".github/renovate.json": '{ "b": 2 }',
		});
		const result = await detectRenovateConfig(octokit, "acme", "repo");
		expect(result).toEqual({
			ok: true,
			data: { path: "renovate.json", config: { a: 1 } },
		});
		// search halts at renovate.json (index 0); later paths are never fetched
		expect(getContent).toHaveBeenCalledTimes(1);
	});

	it("honours the documented search order", async () => {
		const { octokit } = mockReader({
			"renovate.jsonc": '{ "a": 1 }',
			".renovaterc": '{ "b": 2 }',
		});
		const result = await detectRenovateConfig(octokit, "acme", "repo");
		expect(result.ok && result.data?.path).toBe("renovate.jsonc");
	});

	it("surfaces a parse failure of the matched file as an error", async () => {
		const { octokit } = mockReader({ "renovate.json": "{ broken" });
		const result = await detectRenovateConfig(octokit, "acme", "repo");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.message).toContain("renovate.json");
		}
	});
});
