import { type ContentReader, fetchFileContent } from "./deps.ts";
import { parseJson5, parseJsonc } from "./json.ts";
import { err, ok, type Result } from "./result.ts";

/**
 * A parsed Renovate configuration. Renovate configs are free-form JSON objects
 * (validated against Renovate's own schema elsewhere), so this is intentionally
 * an open record rather than a fully typed shape.
 */
export type RenovateConfig = Record<string, unknown>;

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
	"osvVulnerabilityAlerts",
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
		extends: ["config:recommended"],
	},
	"config:recommended": {
		extends: [":dependencyDashboard"],
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
			isRecord(current) && isRecord(value)
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
