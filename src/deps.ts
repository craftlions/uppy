import { valid } from "semver";

export interface Dependency {
	name: string;
	/**
	 * The datasource that resolves this dependency when it differs from the
	 * manager's default datasource. Used by mise, whose full backend identifiers
	 * route `core:*`, `github:*`, `aqua:*`, and `npm:*` through different sources.
	 */
	datasource?: string;
	/**
	 * The package name to pass to the datasource. When absent, {@link name} is
	 * already the datasource name. For mise this strips the backend prefix while
	 * keeping the full identifier visible in dashboards.
	 */
	lookupName?: string;
	/**
	 * The raw manifest spec, used as the lookup `ref` a {@link Datasource}
	 * resolves. For npm and mise this is the version (range operators stripped);
	 * for github-actions it is the raw `@ref` — a tag (`v4.1.0`), a coarse tag
	 * (`v4`), a commit sha, or a branch.
	 */
	version: string;
	/**
	 * Whether the manifest spec is an exact pin (e.g. `1.2.3`) rather than a range
	 * or constraint (e.g. `^1.2.3`, `latest`, `1.x`). Drives the "pin dependency"
	 * listing in the dashboard tables.
	 */
	pinned?: boolean;
	/**
	 * The dependency group this came from, used to match Renovate's
	 * `matchDepTypes` (e.g. `dependencies`, `devDependencies`, `action`). Absent
	 * for managers without dependency types, such as mise.
	 */
	depType?: string;
	/**
	 * The trailing version comment on a sha-pinned github-actions ref
	 * (`@<sha> # v4.1.0`). Cosmetic: uppy reasons over the sha, not the comment,
	 * but it is kept for display and for rewriting the comment on a bump.
	 */
	comment?: string;
	/**
	 * Why uppy recognised this manifest entry but will not attempt to update it.
	 * Unsupported dependencies are rendered for user awareness but excluded from
	 * datasource lookups.
	 */
	unsupportedReason?: string;
}

export interface DependencyFile {
	dependencies: Dependency[];
	file: string;
}

/**
 * One Manager's detected dependencies: the grouping identity uppy owns. The
 * `manager` field is the Manager name (`npm`, `mise`, `github-actions`) the
 * detected `files` were read from. This is uppy's own shape — unrelated to the
 * `ecosystem` vocabulary of external GitHub or OSV payloads.
 */
export interface ManagerDependencies {
	manager: string;
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
	/**
	 * Bump type from current to `target` (or to `heldVersion` when held). The
	 * literal `digest` marks a github-actions recommendation that pins or moves
	 * the commit sha without changing the version.
	 */
	updateType: string;
	/** Whether the update clears the minimum release age window. */
	state: UpdateState;
	/** The newest acceptable version that is still too fresh, when one exists. */
	heldVersion?: string;
	/**
	 * github-actions only: the commit sha the manifest is currently pinned to, or
	 * `undefined` when the action floats on a tag (i.e. is not yet digest-pinned).
	 */
	currentDigest?: string;
	/**
	 * github-actions only: the commit sha uppy recommends pinning to — the sha of
	 * `target` (or of the current version when only a pin is needed). Differs from
	 * `currentDigest` exactly when a pin or digest move is recommended.
	 */
	targetDigest?: string;
}

export interface SafeUpgrade {
	manager: string;
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

const SUPPORTED_MISE_BACKENDS: Record<string, string> = {
	aqua: "aqua",
	core: "core",
	github: "github-releases",
	npm: "npm",
};

const PLAIN_MISE_BACKEND =
	/^(core|github|aqua|npm):([^:[\]{}#]+(?:\/[^:[\]{}#]+)*)$/;

function dependencyForMiseTool(name: string, version: string): Dependency {
	const match = PLAIN_MISE_BACKEND.exec(name);
	if (!match) {
		return {
			name,
			version,
			pinned: isPinnedVersion(version),
			unsupportedReason: name.includes(":")
				? "decorated or unsupported mise backend identity"
				: "mise shorthand is unsupported; use a full backend identifier",
		};
	}
	const [, backend, lookupName] = match;
	return {
		name,
		datasource: SUPPORTED_MISE_BACKENDS[backend],
		lookupName,
		version,
		pinned: isPinnedVersion(version),
	};
}

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

function assignmentIndex(line: string): number {
	let quote: string | null = null;
	for (let index = 0; index < line.length; index += 1) {
		const char = line[index];
		if ((char === '"' || char === "'") && line[index - 1] !== "\\") {
			quote = quote === char ? null : (quote ?? char);
			continue;
		}
		if (char === "=" && quote === null) {
			return index;
		}
	}
	return -1;
}

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
		const eq = assignmentIndex(line);
		if (eq === -1) {
			continue;
		}
		const name = unquote(line.slice(0, eq).trim());
		const version = extractMiseVersion(line.slice(eq + 1).trim());
		deps.push(dependencyForMiseTool(name, version));
	}

	return deps;
}

// The `version` field of an inline-table value, e.g. the `version = "1.17.1"`
// in `{ version = "1.17.1", os = ["linux"] }`. Anchored on the inline-table key
// boundary — the opening `{` or a `,` separator — so `version` is matched only
// as a whole key: a key that merely ends in `version` (e.g. `goversion`) and any
// option value that contains the text are never mistaken for it. Captures the
// boundary + key + `=` prefix and the opening quote, so a replacement swaps only
// the version while keeping spacing, quote style, and the other options intact.
const MISE_INLINE_VERSION = /([{,]\s*version\s*=\s*)(["'])[^"']*\2/;
// A bare quoted string value, e.g. `"1.17.1"`. The single capture is the quote
// char, reused for both ends so the quote style is preserved.
const MISE_STRING_VALUE = /(["'])[^"']*\1/;

// In the replacement strings below `${target}` is template-literal
// interpolation, evaluated at runtime *before* `String.prototype.replace` is
// even called, whereas `$1` and `$2` are regex backreferences resolved *by*
// replace against the captured groups of MISE_INLINE_VERSION / MISE_STRING_VALUE.
// The order is intentional: `${target}` is injected into the literal first, then
// replace re-emits the captured key/prefix ($1) and quote(s) ($2 / $1) around it.
const replaceMiseVersion = (value: string, target: string): string =>
	value.trimStart().startsWith("{")
		? value.replace(MISE_INLINE_VERSION, `$1$2${target}$2`)
		: value.replace(MISE_STRING_VALUE, `$1${target}$1`);

/**
 * Rewrite the version of a single `[tools]` entry in a `mise.toml` in place,
 * touching only the version literal. Crucially the full, quoted backend key
 * (`"core:node"`, `"github:endevco/aube"`, `"aqua:aws/aws-cli"`,
 * `"npm:@openai/codex"`) is preserved exactly — `mise use` would rewrite
 * `"core:node"` to bare `node` and break uppy's backend identity contract.
 * Indentation, quote style, inline-table options, and trailing comments are kept.
 * Matches `pkg` against the unquoted key, the same identity {@link parseMiseToml}
 * surfaces. Throws when no `[tools]` entry matches, so a stale upgrade never
 * silently no-ops into an empty diff.
 *
 * Only the *first* matching entry is rewritten: the `updated` flag short-circuits
 * the rest of the scan, so a duplicate key (mise rejects those anyway) is left
 * untouched. The matched line is split into key and value via
 * {@link assignmentIndex} and the version literal swapped by `replaceMiseVersion`.
 */
export function updateMiseToml(
	content: string,
	pkg: string,
	target: string,
): string {
	let inTools = false;
	let updated = false;
	const lines = content.split("\n").map((raw) => {
		if (updated) {
			return raw;
		}
		const line = raw.trim();
		if (line === "" || line.startsWith("#")) {
			return raw;
		}
		if (line.startsWith("[")) {
			inTools = line === "[tools]";
			return raw;
		}
		const eq = inTools ? assignmentIndex(raw) : -1;
		if (eq === -1 || unquote(raw.slice(0, eq).trim()) !== pkg) {
			return raw;
		}
		updated = true;
		return raw.slice(0, eq + 1) + replaceMiseVersion(raw.slice(eq + 1), target);
	});
	if (!updated) {
		throw new Error(`no [tools] entry for ${pkg} in mise.toml`);
	}
	return lines.join("\n");
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
 * The stable key an {@link UpdateStatus} is stored under in an
 * {@link UpdateRecord}. For most managers a dependency name is unique within a
 * manifest set, so the name suffices. github-actions is the exception: the same
 * `owner/repo` action can appear at different refs across workflow files, so its
 * key includes the ref to keep those occurrences distinct.
 */
export const dependencyKey = (
	dep: Pick<Dependency, "name" | "version" | "depType">,
): string =>
	dep.depType === "action" ? `${dep.name}@${dep.version}` : dep.name;

function isUpdateRecord(
	updates: UpdateRecords,
): updates is Readonly<UpdateRecord> {
	const values = Object.values(updates);
	return (
		values.length === 0 ||
		values.some((value) => typeof value === "object" && "state" in value)
	);
}

function updatesForManager(
	updates: UpdateRecords | undefined,
	manager: string,
): Readonly<UpdateRecord> | undefined {
	if (!updates) {
		return undefined;
	}
	return isUpdateRecord(updates) ? updates : updates[manager];
}

const updateForDependency = (
	updates: Readonly<UpdateRecord>,
	name: string,
): UpdateStatus | undefined => updates[name];

/** List every dependency whose resolved target has aged into a safe update. */
export function listSafeUpgrades(
	managerDependencies: ManagerDependencies[],
	updates?: UpdateRecords,
): SafeUpgrade[] {
	if (!updates) {
		return [];
	}

	const upgrades: SafeUpgrade[] = [];
	for (const group of managerDependencies) {
		const managerUpdates = updatesForManager(updates, group.manager);
		if (!managerUpdates) {
			continue;
		}
		for (const file of group.files) {
			for (const dep of file.dependencies) {
				const status = updateForDependency(managerUpdates, dependencyKey(dep));
				if (status?.target) {
					upgrades.push({
						manager: group.manager,
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
