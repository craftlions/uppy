import type { ContentReader } from "../src/deps.ts";
import { describe, expect, it, vi } from "vitest";
import {
	dependencyDashboardEnabled,
	dependencyTypePinned,
	detectRenovateConfig,
	effectiveRangeStrategy,
	mergeRenovatePresetConfig,
	npmMinimumReleaseAgeMs,
	osvVulnerabilityAlertsEnabled,
	parseDurationMs,
	parseRenovateConfig,
	RENOVATE_CONFIG_PATHS,
	resolveGroupName,
	unknownRenovateConfigOptions,
	vulnerabilityAlertsEnabled,
} from "../src/renovate.ts";

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

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
			data: { dependencyDashboard: true },
		});
	});

	it("parses a .json5 file as JSON5 (single quotes, unquoted keys)", () => {
		const result = parseRenovateConfig(
			"{ extends: ['config:recommended'] }",
			"renovate.json5",
		);
		expect(result).toEqual({
			ok: true,
			data: { dependencyDashboard: true },
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
				dependencyDashboard: true,
				vulnerabilityAlerts: { enabled: true },
			},
		});
	});

	it("merges the :dependencyDashboard preset from extends", () => {
		const result = parseRenovateConfig(
			"{ extends: ['config:recommended', ':dependencyDashboard'] }",
			"renovate.json5",
		);
		expect(result).toEqual({
			ok: true,
			data: {
				dependencyDashboard: true,
			},
		});
	});

	it("merges nested presets from config:recommended", () => {
		const result = parseRenovateConfig(
			"{ extends: ['config:recommended'] }",
			"renovate.json5",
		);
		expect(result).toEqual({
			ok: true,
			data: {
				dependencyDashboard: true,
			},
		});
	});

	it("merges nested presets from config:best-practices, including the npm minimum release age", () => {
		const result = parseRenovateConfig(
			"{ extends: ['config:best-practices'] }",
			"renovate.json5",
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.data.dependencyDashboard).toBe(true);
			expect(Array.isArray(result.data.packageRules)).toBe(true);
			expect(npmMinimumReleaseAgeMs(result.data)).toBe(THREE_DAYS_MS);
		}
	});

	it("merges the :pinDevDependencies preset from extends", () => {
		const result = parseRenovateConfig(
			"{ extends: [':pinDevDependencies'] }",
			"renovate.json5",
		);
		expect(result).toEqual({
			ok: true,
			data: {
				packageRules: [
					{ matchDepTypes: ["devDependencies"], rangeStrategy: "pin" },
				],
			},
		});
	});

	it("merges the security:minimumReleaseAgeNpm preset from extends", () => {
		const result = parseRenovateConfig(
			"{ extends: ['security:minimumReleaseAgeNpm'] }",
			"renovate.json5",
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(npmMinimumReleaseAgeMs(result.data)).toBe(THREE_DAYS_MS);
		}
	});

	it("keeps security:minimumReleaseAgeNpm packageRules when explicit packageRules are configured", () => {
		const result = parseRenovateConfig(
			"{ extends: ['security:minimumReleaseAgeNpm'], packageRules: [{ matchPackageNames: ['vitest'], rangeStrategy: 'bump' }] }",
			"renovate.json5",
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.data.packageRules).toHaveLength(5);
			expect(npmMinimumReleaseAgeMs(result.data)).toBe(THREE_DAYS_MS);
		}
	});

	it("lets explicit packageRules override security:minimumReleaseAgeNpm packageRules", () => {
		const result = parseRenovateConfig(
			"{ extends: ['security:minimumReleaseAgeNpm'], packageRules: [{ matchDatasources: ['npm'], minimumReleaseAge: '7 days' }] }",
			"renovate.json5",
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(npmMinimumReleaseAgeMs(result.data)).toBe(7 * 24 * 60 * 60 * 1000);
		}
	});

	it("lets explicit dependencyDashboard config override preset values", () => {
		const result = parseRenovateConfig(
			"{ extends: [':dependencyDashboard'], dependencyDashboard: false }",
			"renovate.json5",
		);
		expect(result).toEqual({
			ok: true,
			data: {
				dependencyDashboard: false,
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
				dependencyDashboard: true,
				extends: ["config:recommended"],
				ignoreUnstable: false,
				osvVulnerabilityAlerts: true,
				packageRules: [],
				timezone: "UTC",
				vulnerabilityAlerts: { enabled: true },
			}),
		).toEqual(["timezone"]);
	});
});

describe("parseDurationMs", () => {
	it("parses Renovate duration strings to milliseconds", () => {
		expect(parseDurationMs("3 days")).toBe(THREE_DAYS_MS);
		expect(parseDurationMs("1 day")).toBe(24 * 60 * 60 * 1000);
		expect(parseDurationMs("12 hours")).toBe(12 * 60 * 60 * 1000);
		expect(parseDurationMs("2 weeks")).toBe(14 * 24 * 60 * 60 * 1000);
		expect(parseDurationMs("30 minutes")).toBe(30 * 60 * 1000);
	});

	it("returns null for unrecognized durations", () => {
		expect(parseDurationMs("soon")).toBeNull();
		expect(parseDurationMs("")).toBeNull();
	});
});

describe("npmMinimumReleaseAgeMs", () => {
	it("reads the minimum release age from an npm packageRule", () => {
		expect(
			npmMinimumReleaseAgeMs({
				packageRules: [
					{ matchDatasources: ["npm"], minimumReleaseAge: "7 days" },
				],
			}),
		).toBe(7 * 24 * 60 * 60 * 1000);
	});

	it("ignores rules that do not target npm", () => {
		expect(
			npmMinimumReleaseAgeMs({
				packageRules: [
					{ matchDatasources: ["docker"], minimumReleaseAge: "30 days" },
				],
			}),
		).toBeNull();
	});

	it("lets a later npm rule override an earlier one", () => {
		expect(
			npmMinimumReleaseAgeMs({
				minimumReleaseAge: "1 day",
				packageRules: [
					{ matchDatasources: ["npm"], minimumReleaseAge: "5 days" },
				],
			}),
		).toBe(5 * 24 * 60 * 60 * 1000);
	});

	it("returns null when no minimum release age is configured", () => {
		expect(npmMinimumReleaseAgeMs({ dependencyDashboard: true })).toBeNull();
	});
});

describe("effectiveRangeStrategy", () => {
	it("returns null when no rangeStrategy is configured", () => {
		expect(effectiveRangeStrategy({}, "devDependencies")).toBeNull();
	});

	it("reads the top-level rangeStrategy", () => {
		expect(
			effectiveRangeStrategy({ rangeStrategy: "bump" }, "dependencies"),
		).toBe("bump");
	});

	it("applies a packageRule only to its matching depType", () => {
		const config = {
			packageRules: [
				{ matchDepTypes: ["devDependencies"], rangeStrategy: "pin" },
			],
		};
		expect(effectiveRangeStrategy(config, "devDependencies")).toBe("pin");
		expect(effectiveRangeStrategy(config, "dependencies")).toBeNull();
	});

	it("lets a later matching rule override an earlier one", () => {
		expect(
			effectiveRangeStrategy(
				{
					rangeStrategy: "replace",
					packageRules: [
						{ matchDepTypes: ["devDependencies"], rangeStrategy: "pin" },
					],
				},
				"devDependencies",
			),
		).toBe("pin");
	});

	it("ignores rules that do not target npm", () => {
		expect(
			effectiveRangeStrategy(
				{
					packageRules: [
						{ matchDatasources: ["docker"], rangeStrategy: "pin" },
					],
				},
				"dependencies",
			),
		).toBeNull();
	});
});

describe("dependencyTypePinned", () => {
	it("is true when the :pinDevDependencies preset targets the depType", () => {
		const result = parseRenovateConfig(
			"{ extends: [':pinDevDependencies'] }",
			"renovate.json5",
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(dependencyTypePinned(result.data, "devDependencies")).toBe(true);
			expect(dependencyTypePinned(result.data, "dependencies")).toBe(false);
		}
	});

	it("is false without a pin rangeStrategy", () => {
		expect(dependencyTypePinned({}, "devDependencies")).toBe(false);
		expect(
			dependencyTypePinned({ rangeStrategy: "bump" }, "devDependencies"),
		).toBe(false);
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

describe("dependencyDashboardEnabled", () => {
	it("enables dashboard issue updates only when the option is true", () => {
		expect(dependencyDashboardEnabled({ dependencyDashboard: true })).toBe(
			true,
		);
		expect(dependencyDashboardEnabled({ dependencyDashboard: false })).toBe(
			false,
		);
		expect(dependencyDashboardEnabled({})).toBe(false);
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

describe("resolveGroupName", () => {
	it("returns undefined when there are no packageRules", () => {
		expect(resolveGroupName({}, { name: "astro" })).toBeUndefined();
	});

	it("matches by package name", () => {
		expect(
			resolveGroupName(
				{
					packageRules: [
						{ matchPackageNames: ["astro"], groupName: "Astro" },
					],
				},
				{ name: "astro" },
			),
		).toBe("Astro");
	});

	it("matches by pattern", () => {
		expect(
			resolveGroupName(
				{
					packageRules: [
						{
							matchPackagePatterns: ["^@astrojs/"],
							groupName: "Astro",
						},
					],
				},
				{ name: "@astrojs/rss" },
			),
		).toBe("Astro");
	});

	it("matches by depType and updateType", () => {
		expect(
			resolveGroupName(
				{
					packageRules: [
						{
							matchDepTypes: ["devDependencies"],
							matchUpdateTypes: ["minor"],
							groupName: "Dev minors",
						},
					],
				},
				{ name: "vitest", depType: "devDependencies", updateType: "minor" },
			),
		).toBe("Dev minors");
	});

	it("returns undefined when the depType does not match", () => {
		expect(
			resolveGroupName(
				{
					packageRules: [
						{
							matchDepTypes: ["devDependencies"],
							groupName: "Dev",
						},
					],
				},
				{ name: "react", depType: "dependencies" },
			),
		).toBeUndefined();
	});

	it("lets the last matching rule win", () => {
		expect(
			resolveGroupName(
				{
					packageRules: [
						{
							matchPackageNames: ["@astrojs/rss"],
							groupName: "First",
						},
						{
							matchPackagePatterns: ["^@astrojs/"],
							groupName: "Astro",
						},
					],
				},
				{ name: "@astrojs/rss" },
			),
		).toBe("Astro");
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
				config: { dependencyDashboard: true },
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
