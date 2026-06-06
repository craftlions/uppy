import { valid } from "semver";

export interface Dependency {
	name: string;
	version: string;
	/**
	 * Whether the manifest spec is an exact pin (e.g. `1.2.3`) rather than a range
	 * or constraint (e.g. `^1.2.3`, `latest`, `1.x`). Drives the "pin dependency"
	 * listing in the dashboard tables.
	 */
	pinned?: boolean;
	/**
	 * The dependency group this came from, used to match Renovate's
	 * `matchDepTypes` (e.g. `dependencies`, `devDependencies`). Absent for
	 * ecosystems without dependency types, such as mise.
	 */
	depType?: string;
}

export interface DependencyFile {
	dependencies: Dependency[];
	file: string;
}

export interface DependencyEcosystem {
	ecosystem: string;
	files: DependencyFile[];
}

/**
 * The result of a Renovate-style update check for a single dependency: the
 * version it would be bumped to and the kind of bump. Produced by
 * `resolveUpdate` in `./outdated.ts` and keyed by package name.
 */
export interface OutdatedInfo {
	/** The version currently pinned in the manifest. */
	current: string;
	/** The version Renovate's default policy would update to. */
	target: string;
	/** Semver bump type from current to target, e.g. `major`, `minor`, `patch`. */
	updateType: string;
}

/**
 * Whether the recommended update clears the minimum release age window.
 *
 * - `safe`: the newest acceptable version is old enough to update to.
 * - `safe-newer-held`: a safe target exists, but an even newer version is still
 *   too fresh and is held back until it ages in.
 * - `held`: every acceptable version is still too fresh; nothing is safe yet.
 */
export type UpdateState = "held" | "safe" | "safe-newer-held";

/**
 * An update check that also accounts for the minimum release age policy.
 * Dependencies with no available update are omitted from the results entirely
 * (rendered as "up to date").
 */
export interface UpdateStatus {
	/** The version currently pinned in the manifest. */
	current: string;
	/**
	 * The newest version old enough to recommend, or `null` when no acceptable
	 * version has aged past the minimum release age yet.
	 */
	target: string | null;
	/** Semver bump type from current to `target` (or to `heldVersion` when held). */
	updateType: string;
	/** Whether the update clears the minimum release age window. */
	state: UpdateState;
	/** The newest acceptable version that is still too fresh, when one exists. */
	heldVersion?: string;
}

export interface SafeUpgrade {
	ecosystem: string;
	manifest: string;
	package: string;
	current: string;
	target: string;
	updateType: string;
	depType?: string;
}

export type UpdateRecord = Record<string, UpdateStatus>;

export type UpdateRecords =
	| Readonly<UpdateRecord>
	| Partial<Record<string, UpdateRecord>>;

/**
 * Minimal Octokit shape required to read file contents. Keeping it narrow makes
 * the function trivial to mock in unit tests while staying compatible with a
 * real Octokit instance.
 */
export interface ContentReader {
	rest: {
		repos: {
			getContent: (params: {
				owner: string;
				repo: string;
				path: string;
			}) => Promise<{ data: unknown }>;
		};
	};
}

const LEADING_QUOTE = /^['"]/;
const TRAILING_QUOTE = /['"]$/;
const INLINE_VERSION = /version\s*=\s*["']([^"']+)["']/;
const NPM_RANGE_PREFIX = /^[\^~>=<\s]+/;
const WHITESPACE = /\s/g;

const unquote = (value: string): string =>
	value.replace(LEADING_QUOTE, "").replace(TRAILING_QUOTE, "");

const extractMiseVersion = (rawValue: string): string => {
	// Inline table form, e.g. { version = "1.17.1", os = ["linux"] }
	if (rawValue.startsWith("{")) {
		const match = rawValue.match(INLINE_VERSION);
		return match ? match[1] : "";
	}
	return unquote(rawValue);
};

/** Take the bare tool name from a mise key like `github:endevco/aube`. */
const normalizeMiseName = (key: string): string => {
	const afterSlash = key.split("/").at(-1) ?? key;
	return afterSlash.split(":").at(-1) ?? afterSlash;
};

/** Strip semver range operators from an npm version spec, e.g. `^1.2.3`. */
const cleanNpmVersion = (version: string): string =>
	version.replace(NPM_RANGE_PREFIX, "").trim();

/**
 * Whether a manifest version spec is an exact pin rather than a range or
 * constraint. A spec is pinned only when it is a single, fully-qualified semver
 * version (`1.2.3`, `1.2.3-rc.1`); anything carrying a range operator or
 * wildcard (`^1.2.3`, `~1.2`, `1.x`, `*`, `latest`) is not.
 */
const isPinnedVersion = (version: string): boolean =>
	valid(version.trim()) !== null;

/** Parse the `[tools]` table of a mise.toml file into dependencies. */
export function parseMiseToml(content: string): Dependency[] {
	const deps: Dependency[] = [];
	let inTools = false;

	for (const rawLine of content.split("\n")) {
		const line = rawLine.trim();
		if (line === "" || line.startsWith("#")) {
			continue;
		}
		if (line.startsWith("[")) {
			inTools = line === "[tools]";
			continue;
		}
		if (!inTools) {
			continue;
		}
		const eq = line.indexOf("=");
		if (eq === -1) {
			continue;
		}
		const name = normalizeMiseName(unquote(line.slice(0, eq).trim()));
		const version = extractMiseVersion(line.slice(eq + 1).trim());
		deps.push({ name, version, pinned: isPinnedVersion(version) });
	}

	return deps;
}

/** Parse `dependencies` and `devDependencies` of a package.json file. */
export function parsePackageJson(content: string): Dependency[] {
	const pkg = JSON.parse(content) as {
		dependencies?: Record<string, string>;
		devDependencies?: Record<string, string>;
	};
	const groups: [string, Record<string, string> | undefined][] = [
		["dependencies", pkg.dependencies],
		["devDependencies", pkg.devDependencies],
	];
	const deps: Dependency[] = [];
	for (const [depType, group] of groups) {
		for (const [name, spec] of Object.entries(group ?? {})) {
			deps.push({
				name,
				version: cleanNpmVersion(spec),
				pinned: isPinnedVersion(spec),
				depType,
			});
		}
	}
	return deps;
}

/** Read a file from a repository and decode it, or null if it is missing. */
export async function fetchFileContent(
	octokit: ContentReader,
	owner: string,
	repo: string,
	path: string,
): Promise<string | null> {
	try {
		const { data } = await octokit.rest.repos.getContent({ owner, repo, path });
		if (
			data &&
			!Array.isArray(data) &&
			typeof data === "object" &&
			"type" in data &&
			data.type === "file" &&
			"content" in data &&
			typeof data.content === "string"
		) {
			return atob(data.content.replace(WHITESPACE, ""));
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Read the supported manifest files from a repository and parse the installed
 * dependencies and versions grouped by ecosystem.
 */
export async function detectDependencies(
	octokit: ContentReader,
	owner: string,
	repo: string,
): Promise<DependencyEcosystem[]> {
	const ecosystems: DependencyEcosystem[] = [];

	const miseContent = await fetchFileContent(octokit, owner, repo, "mise.toml");
	if (miseContent) {
		const dependencies = parseMiseToml(miseContent);
		if (dependencies.length > 0) {
			ecosystems.push({
				ecosystem: "mise",
				files: [{ file: "mise.toml", dependencies }],
			});
		}
	}

	const pkgContent = await fetchFileContent(
		octokit,
		owner,
		repo,
		"package.json",
	);
	if (pkgContent) {
		const dependencies = parsePackageJson(pkgContent);
		if (dependencies.length > 0) {
			ecosystems.push({
				ecosystem: "npm",
				files: [{ file: "package.json", dependencies }],
			});
		}
	}

	return ecosystems;
}

function isUpdateRecord(
	updates: UpdateRecords,
): updates is Readonly<UpdateRecord> {
	const values = Object.values(updates);
	return (
		values.length === 0 ||
		values.some((value) => typeof value === "object" && "state" in value)
	);
}

function updatesForEcosystem(
	updates: UpdateRecords | undefined,
	ecosystem: string,
): Readonly<UpdateRecord> | undefined {
	if (!updates) {
		return undefined;
	}
	return isUpdateRecord(updates) ? updates : updates[ecosystem];
}

const updateForDependency = (
	updates: Readonly<UpdateRecord>,
	name: string,
): UpdateStatus | undefined => updates[name];

/** List every dependency whose resolved target has aged into a safe update. */
export function listSafeUpgrades(
	ecosystems: DependencyEcosystem[],
	updates?: UpdateRecords,
): SafeUpgrade[] {
	if (!updates) {
		return [];
	}

	const upgrades: SafeUpgrade[] = [];
	for (const eco of ecosystems) {
		const ecosystemUpdates = updatesForEcosystem(updates, eco.ecosystem);
		if (!ecosystemUpdates) {
			continue;
		}
		for (const file of eco.files) {
			for (const dep of file.dependencies) {
				const status = updateForDependency(ecosystemUpdates, dep.name);
				if (status?.target) {
					upgrades.push({
						ecosystem: eco.ecosystem,
						manifest: file.file,
						package: dep.name,
						current: status.current,
						target: status.target,
						updateType: status.updateType,
						depType: dep.depType,
					});
				}
			}
		}
	}
	return upgrades;
}
