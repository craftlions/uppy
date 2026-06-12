import { type ContentReader, fetchFileContent } from "./deps.ts";
import { parseJson5, parseJsonc } from "./json.ts";
import { err, ok, type Result } from "./result.ts";

/**
 * A parsed Renovate configuration. Renovate configs are free-form JSON objects
 * (validated against Renovate's own schema elsewhere), so this stays open while
 * still matching the structured-clone shape Workflow steps require.
 */
export type RenovateConfigValue = Rpc.Serializable<unknown>;

export type RenovateConfig = Record<string, RenovateConfigValue>;

/**
 * Renovate config options this worker knows how to interpret. Other top-level
 * keys are still returned in `config`, but are reported separately so callers
 * can tell which options are outside this parser's current behavior.
 */
export const KNOWN_RENOVATE_CONFIG_OPTIONS = [
	"$schema",
	"dependencyDashboard",
	"extends",
	"ignoreUnstable",
	"minimumReleaseAge",
	"osvVulnerabilityAlerts",
	"packageRules",
	"rangeStrategy",
	"respectLatest",
	"vulnerabilityAlerts",
] as const;

const knownRenovateConfigOptions = new Set<string>(
	KNOWN_RENOVATE_CONFIG_OPTIONS,
);

/** A located Renovate config: the repository path it came from and its parsed body. */
export interface RenovateConfigResult {
	/** The parsed configuration object. */
	config: RenovateConfig;
	/** The repository-relative path the config was found at. */
	path: string;
}

/**
 * The Renovate config file locations, in the exact order Renovate searches
 * them. Renovate stops at the first match, so order is significant.
 *
 * @see https://docs.renovatebot.com/configuration-options/
 */
export const RENOVATE_CONFIG_PATHS = [
	"renovate.json",
	"renovate.jsonc",
	"renovate.json5",
	".github/renovate.json",
	".github/renovate.jsonc",
	".github/renovate.json5",
	".renovaterc",
	".renovaterc.json",
	".renovaterc.jsonc",
	".renovaterc.json5",
] as const;

/**
 * Parse the raw contents of a Renovate config file. The dialect is chosen from
 * the file extension: `.json5` files are parsed as JSON5, everything else
 * (`.json`, `.jsonc` and the extension-less `.renovaterc`) as JSONC, which is
 * how Renovate itself treats them.
 *
 * Never throws: a syntax error or a non-object top level is returned as the
 * `error` arm of the {@link Result}.
 */
export function parseRenovateConfig(
	content: string,
	path: string,
): Result<RenovateConfig> {
	let value: unknown;
	try {
		value = path.endsWith(".json5") ? parseJson5(content) : parseJsonc(content);
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : String(cause);
		return err(
			new Error(`Failed to parse Renovate config ${path}: ${message}`),
		);
	}

	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return err(new Error(`Renovate config ${path} must be a JSON object`));
	}
	return ok(mergeRenovatePresetConfig(value as RenovateConfig));
}

const RENOVATE_PRESET_CONFIGS: Record<string, RenovateConfig> = {
	":dependencyDashboard": {
		dependencyDashboard: true,
	},
	":enableVulnerabilityAlerts": {
		vulnerabilityAlerts: {
			enabled: true,
		},
	},
	"config:best-practices": {
		extends: ["config:recommended", "security:minimumReleaseAgeNpm"],
	},
	"config:recommended": {
		extends: [":dependencyDashboard"],
	},
	// https://docs.renovatebot.com/presets-default/#pindevdependencies
	":pinDevDependencies": {
		packageRules: [
			{
				matchDepTypes: ["devDependencies"],
				rangeStrategy: "pin",
			},
		],
	},
	// https://docs.renovatebot.com/presets-security/#securityminimumreleaseagenpm
	"security:minimumReleaseAgeNpm": {
		packageRules: [
			{
				internalChecksFilter: "strict",
				matchDatasources: ["npm"],
				minimumReleaseAge: "3 days",
			},
			{
				matchDatasources: ["npm"],
				matchUpdateTypes: ["lockFileMaintenance"],
				minimumReleaseAge: null,
			},
			{
				matchDatasources: ["npm"],
				matchUpdateTypes: ["replacement"],
				minimumReleaseAge: null,
			},
			{
				matchDatasources: ["npm"],
				matchUpdateTypes: ["pin"],
				minimumReleaseAge: null,
			},
		],
	},
};

const isRecord = (value: unknown): value is RenovateConfig =>
	value !== null && typeof value === "object" && !Array.isArray(value);

function mergeConfig(
	base: RenovateConfig,
	override: RenovateConfig,
): RenovateConfig {
	const merged: RenovateConfig = { ...base };
	for (const [key, value] of Object.entries(override)) {
		const current = merged[key];
		merged[key] =
			Array.isArray(current) && Array.isArray(value)
				? [...current, ...value]
				: isRecord(current) && isRecord(value)
					? mergeConfig(current, value)
					: value;
	}
	return merged;
}

function extendsPresets(config: RenovateConfig): string[] {
	const extendsValue = config.extends;
	if (typeof extendsValue === "string") {
		return [extendsValue];
	}
	if (Array.isArray(extendsValue)) {
		return extendsValue.filter(
			(preset): preset is string => typeof preset === "string",
		);
	}
	return [];
}

function removeMergedPresets(config: RenovateConfig): RenovateConfig {
	const extendsValue = config.extends;
	if (typeof extendsValue === "string") {
		return RENOVATE_PRESET_CONFIGS[extendsValue]
			? Object.fromEntries(
					Object.entries(config).filter(([key]) => key !== "extends"),
				)
			: config;
	}
	if (!Array.isArray(extendsValue)) {
		return config;
	}
	const remainingExtends = extendsValue.filter(
		(preset) =>
			typeof preset !== "string" ||
			RENOVATE_PRESET_CONFIGS[preset] === undefined,
	);
	if (remainingExtends.length === extendsValue.length) {
		return config;
	}
	if (remainingExtends.length === 0) {
		return Object.fromEntries(
			Object.entries(config).filter(([key]) => key !== "extends"),
		);
	}
	return { ...config, extends: remainingExtends };
}

/** Merge worker-supported Renovate presets into the returned config object. */
export function mergeRenovatePresetConfig(
	config: RenovateConfig,
): RenovateConfig {
	const resolvePresetConfig = (
		preset: string,
		seen: Set<string>,
	): RenovateConfig => {
		const presetConfig = RENOVATE_PRESET_CONFIGS[preset];
		if (!presetConfig || seen.has(preset)) {
			return {};
		}
		const nextSeen = new Set(seen).add(preset);
		const nestedPresetConfig = extendsPresets(
			presetConfig,
		).reduce<RenovateConfig>(
			(merged, nestedPreset) =>
				mergeConfig(merged, resolvePresetConfig(nestedPreset, nextSeen)),
			{},
		);
		return mergeConfig(nestedPresetConfig, removeMergedPresets(presetConfig));
	};
	const presetConfig = extendsPresets(config).reduce<RenovateConfig>(
		(merged, preset) => {
			return mergeConfig(merged, resolvePresetConfig(preset, new Set()));
		},
		{},
	);
	return mergeConfig(presetConfig, removeMergedPresets(config));
}

/** Return top-level config option names not handled by this parser. */
export function unknownRenovateConfigOptions(config: RenovateConfig): string[] {
	return Object.keys(config).filter(
		(option) => !knownRenovateConfigOptions.has(option),
	);
}

/** Return whether Renovate Dependency Dashboard checks are enabled in config. */
export function dependencyDashboardEnabled(config: RenovateConfig): boolean {
	return config.dependencyDashboard === true;
}

/** Return whether OSV vulnerability alert checks are enabled in config. */
export function osvVulnerabilityAlertsEnabled(config: RenovateConfig): boolean {
	return config.osvVulnerabilityAlerts === true;
}

/** Return whether GitHub Vulnerability Alert checks are enabled in config. */
export function vulnerabilityAlertsEnabled(config: RenovateConfig): boolean {
	const vulnerabilityAlerts = config.vulnerabilityAlerts;
	return isRecord(vulnerabilityAlerts) && vulnerabilityAlerts.enabled === true;
}

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const DURATION = /^(\d+)\s*(minute|hour|day|week|month|year)s?$/i;
const DURATION_UNIT_MS: Record<string, number> = {
	minute: MS_PER_MINUTE,
	hour: MS_PER_HOUR,
	day: MS_PER_DAY,
	week: 7 * MS_PER_DAY,
	month: 30 * MS_PER_DAY,
	year: 365 * MS_PER_DAY,
};

/**
 * Parse a Renovate duration string such as `"3 days"`, `"12 hours"` or
 * `"1 week"` into milliseconds. Returns `null` for anything we don't recognize.
 */
export function parseDurationMs(text: string): number | null {
	const match = DURATION.exec(text.trim());
	if (!match) {
		return null;
	}
	const unitName = match[2];
	if (unitName === undefined) {
		return null;
	}
	const unit = DURATION_UNIT_MS[unitName.toLowerCase()];
	return unit === undefined ? null : Number(match[1]) * unit;
}

const ruleAppliesToNpm = (rule: RenovateConfig): boolean => {
	const datasources = rule.matchDatasources;
	if (datasources === undefined) {
		return true;
	}
	return Array.isArray(datasources) && datasources.includes("npm");
};

const ruleAppliesToDepType = (
	rule: RenovateConfig,
	depType: string,
): boolean => {
	const depTypes = rule.matchDepTypes;
	if (depTypes === undefined) {
		return true;
	}
	return Array.isArray(depTypes) && depTypes.includes(depType);
};

/**
 * Convert a Renovate glob pattern (e.g. `@astrojs/*`) into an anchored RegExp.
 * Only `*` (any sequence) and `?` (any single char) wildcards are supported;
 * other regex metacharacters are escaped.
 */
function globToRegex(pattern: string): RegExp {
	const escaped = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".");
	return new RegExp(`^${escaped}$`);
}

/**
 * Test whether a package name matches a single `matchPackageNames` entry.
 * Supports exact names, glob patterns, and regexes delimited by `/.../`.
 */
function packageNameMatchesPattern(name: string, pattern: string): boolean {
	if (pattern.startsWith("/") && pattern.endsWith("/")) {
		return new RegExp(pattern.slice(1, -1)).test(name);
	}
	return globToRegex(pattern).test(name);
}

/**
 * Test whether a dependency name matches the `matchPackageNames` criterion of a
 * package rule. Negated entries (`!pattern`) exclude the dependency; positive
 * entries require at least one match. When the list contains only negations the
 * default is to match everything except excluded names.
 */
function matchPackageNames(
	name: string,
	matchers: RenovateConfigValue,
): boolean {
	if (!Array.isArray(matchers)) {
		return true;
	}
	const positives: string[] = [];
	const negatives: string[] = [];
	for (const matcher of matchers) {
		if (typeof matcher !== "string") {
			continue;
		}
		if (matcher.startsWith("!")) {
			negatives.push(matcher.slice(1));
		} else {
			positives.push(matcher);
		}
	}
	if (negatives.some((pattern) => packageNameMatchesPattern(name, pattern))) {
		return false;
	}
	if (positives.length === 0) {
		return true;
	}
	return positives.some((pattern) => packageNameMatchesPattern(name, pattern));
}

/**
 * Test whether a dependency name matches the `matchPackagePatterns` criterion of
 * a package rule. Each pattern is a regex (optionally delimited by `/.../`);
 * at least one pattern must match.
 */
function matchPackagePatterns(
	name: string,
	patterns: RenovateConfigValue,
): boolean {
	if (!Array.isArray(patterns)) {
		return true;
	}
	return patterns.some((pattern) => {
		if (typeof pattern !== "string") {
			return false;
		}
		const source =
			pattern.startsWith("/") && pattern.endsWith("/")
				? pattern.slice(1, -1)
				: pattern;
		return new RegExp(source).test(name);
	});
}

/**
 * Test whether a string value matches an exact-string-list criterion such as
 * `matchDepTypes` or `matchUpdateTypes`.
 */
function matchStringCriterion(
	value: string | undefined,
	matchers: RenovateConfigValue,
): boolean {
	if (!Array.isArray(matchers)) {
		return true;
	}
	if (value === undefined) {
		return false;
	}
	return matchers.includes(value);
}

/**
 * Determine whether a Renovate `packageRule` applies to a dependency. Criteria
 * are combined with AND logic; array criteria match when any element matches
 * (OR within the array). Negations inside `matchPackageNames` are honoured.
 */
export function packageRuleMatches(
	rule: RenovateConfig,
	dep: { name: string; depType?: string; updateType?: string },
): boolean {
	return (
		matchPackageNames(dep.name, rule.matchPackageNames) &&
		matchPackagePatterns(dep.name, rule.matchPackagePatterns) &&
		matchStringCriterion(dep.depType, rule.matchDepTypes) &&
		matchStringCriterion(dep.updateType, rule.matchUpdateTypes)
	);
}

/**
 * Resolve the `groupName` Renovate would assign to a dependency from the config's
 * `packageRules`. Rules are evaluated in order and the last matching rule wins,
 * mirroring Renovate. Returns `undefined` when no rule assigns a group.
 *
 * @see https://docs.renovatebot.com/configuration-options/#groupname
 */
export function resolveGroupName(
	config: RenovateConfig,
	dep: { name: string; depType?: string; updateType?: string },
): string | undefined {
	const rules = config.packageRules;
	if (!Array.isArray(rules)) {
		return undefined;
	}
	let groupName: string | undefined;
	for (const rule of rules) {
		if (!isRecord(rule)) {
			continue;
		}
		if (packageRuleMatches(rule, dep) && typeof rule.groupName === "string") {
			groupName = rule.groupName;
		}
	}
	return groupName;
}

/**
 * Resolve the `rangeStrategy` Renovate would apply to a dependency of the given
 * `depType`, reading the top-level option and any `packageRules` whose
 * `matchDepTypes`/`matchDatasources` select it (later rules win, mirroring
 * Renovate). Returns `null` when none is configured — Renovate then defaults to
 * `"replace"`, which keeps existing ranges as-is.
 *
 * @see https://docs.renovatebot.com/configuration-options/#rangestrategy
 */
export function effectiveRangeStrategy(
	config: RenovateConfig,
	depType: string,
): string | null {
	let result =
		typeof config.rangeStrategy === "string" ? config.rangeStrategy : null;

	const rules = config.packageRules;
	if (Array.isArray(rules)) {
		for (const rule of rules) {
			if (
				isRecord(rule) &&
				ruleAppliesToNpm(rule) &&
				ruleAppliesToDepType(rule, depType) &&
				typeof rule.rangeStrategy === "string"
			) {
				result = rule.rangeStrategy;
			}
		}
	}

	return result;
}

/**
 * Whether config asks dependencies of the given `depType` to be pinned, i.e. the
 * effective {@link effectiveRangeStrategy} resolves to `"pin"`. This is what the
 * `:pinDevDependencies` preset turns on for `devDependencies`.
 */
export function dependencyTypePinned(
	config: RenovateConfig,
	depType: string,
): boolean {
	return effectiveRangeStrategy(config, depType) === "pin";
}

/**
 * Determine the configured `minimumReleaseAge` (in milliseconds) that applies to
 * npm dependencies, reading both the top-level option and any `packageRules`
 * (later rules win, mirroring Renovate). Returns `null` when no applicable
 * minimum release age is configured.
 */
export function npmMinimumReleaseAgeMs(config: RenovateConfig): number | null {
	let result =
		typeof config.minimumReleaseAge === "string"
			? parseDurationMs(config.minimumReleaseAge)
			: null;

	const rules = config.packageRules;
	if (Array.isArray(rules)) {
		for (const rule of rules) {
			if (
				isRecord(rule) &&
				ruleAppliesToNpm(rule) &&
				typeof rule.minimumReleaseAge === "string"
			) {
				const ms = parseDurationMs(rule.minimumReleaseAge);
				if (ms !== null) {
					result = ms;
				}
			}
		}
	}

	return result;
}

/**
 * Search a repository for a Renovate config, trying {@link RENOVATE_CONFIG_PATHS}
 * in order and stopping at the first file that exists — exactly mirroring how
 * Renovate resolves its config.
 *
 * Returns a {@link Result} that never throws:
 * - `{ ok: true, data: { path, config } }` when a config is found and parsed —
 *   the caller should continue.
 * - `{ ok: true, data: null }` when no config file exists anywhere — the caller
 *   should stop; this is not an error.
 * - `{ ok: false, error }` when a config is found but cannot be parsed.
 */
export async function detectRenovateConfig(
	octokit: ContentReader,
	owner: string,
	repo: string,
): Promise<Result<RenovateConfigResult | null>> {
	for (const path of RENOVATE_CONFIG_PATHS) {
		// Sequential by design: Renovate stops searching at the first match, so we
		// must not read past it.
		const content = await fetchFileContent(octokit, owner, repo, path);
		if (content === null) {
			continue;
		}
		const parsed = parseRenovateConfig(content, path);
		if (!parsed.ok) {
			return parsed;
		}
		return ok({ path, config: parsed.data });
	}
	return ok(null);
}
