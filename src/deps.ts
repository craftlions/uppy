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
}

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

const countDependencies = (eco: DependencyEcosystem): number =>
	eco.files.reduce((sum, file) => sum + file.dependencies.length, 0);

const UP_TO_DATE = "✅ up to date";
const PIN = "📌 pin";

/**
 * Pick the `Target` and `Update` table cells for a dependency given its update
 * status. Absent status means the dependency is up to date. The icons encode the
 * four states from {@link UpdateStatus}: a green safe update, a safe update that
 * additionally holds back a newer (still too fresh) version, and an update where
 * every available version is still within the minimum release age window.
 *
 * When `needsPin` is set the dependency carries a range the config wants pinned
 * (see Renovate's `:pinDevDependencies`): a `📌 pin` action is shown on its own
 * when otherwise up to date, or appended to whatever update is pending.
 */
function updateCells(
	status: UpdateStatus | undefined,
	needsPin: boolean,
): {
	target: string;
	update: string;
} {
	const cells = updateStatusCells(status);
	if (needsPin) {
		cells.update = cells.update === UP_TO_DATE ? PIN : `${cells.update} ${PIN}`;
	}
	return cells;
}

function updateStatusCells(status: UpdateStatus | undefined): {
	target: string;
	update: string;
} {
	if (!status) {
		return { target: "—", update: UP_TO_DATE };
	}
	if (status.state === "held") {
		return {
			target: "—",
			update: `⏳ ${status.updateType} held (\`${status.heldVersion}\`)`,
		};
	}
	const safe = `🟢 ${status.updateType} (safe)`;
	if (status.state === "safe-newer-held") {
		return {
			target: `\`${status.target}\``,
			update: `${safe} ⏳ newer held (\`${status.heldVersion}\`)`,
		};
	}
	return { target: `\`${status.target}\``, update: safe };
}

/** Ecosystems whose tables gain `Target`/`Update` columns when updates are known. */
const UPDATABLE_ECOSYSTEMS = new Set(["npm", "mise"]);

/** Render a plain `Package | Version | Manifest` table for an ecosystem. */
function renderPlainSection(eco: DependencyEcosystem): string {
	const rows = eco.files
		.flatMap((file) =>
			file.dependencies.map(
				(dep) => `| \`${dep.name}\` | \`${dep.version}\` | \`${file.file}\` |`,
			),
		)
		.join("\n");
	return `### ${eco.ecosystem} (${countDependencies(eco)})\n\n| Package | Version | Manifest |\n| --- | --- | --- |\n${rows}`;
}

/**
 * Render an ecosystem with extra `Target` and `Update` columns, flagging the
 * deps that Renovate's default policy would bump. Deps without an entry in
 * `updates` are shown as up to date.
 */
function renderUpdatableSection(
	eco: DependencyEcosystem,
	updates: Map<string, UpdateStatus>,
	pins: ReadonlySet<string>,
): string {
	const rows = eco.files
		.flatMap((file) =>
			file.dependencies.map((dep) => {
				const { target, update } = updateCells(
					updates.get(dep.name),
					pins.has(dep.name),
				);
				return `| \`${dep.name}\` | \`${dep.version}\` | ${target} | ${update} | \`${file.file}\` |`;
			}),
		)
		.join("\n");
	return `### ${eco.ecosystem} (${countDependencies(eco)})\n\n| Package | Current | Target | Update | Manifest |\n| --- | --- | --- | --- | --- |\n${rows}`;
}

/**
 * Render detected dependencies as a Markdown table per ecosystem. When an
 * `updates` map is supplied, the `npm` and `mise` ecosystems gain
 * `Target`/`Update` columns describing the Renovate-style bump for each
 * outdated dependency. Names in `pins` are additionally flagged with a `📌 pin`
 * action, listing dependencies the config wants pinned but that still carry a
 * range.
 */
export function renderDependencies(
	ecosystems: DependencyEcosystem[],
	updates?: Map<string, UpdateStatus>,
	pins: ReadonlySet<string> = new Set(),
): string {
	if (ecosystems.length === 0) {
		return "";
	}

	const sections = ecosystems.map((eco) =>
		updates && UPDATABLE_ECOSYSTEMS.has(eco.ecosystem)
			? renderUpdatableSection(eco, updates, pins)
			: renderPlainSection(eco),
	);

	return `## Detected Dependencies\n\n${sections.join("\n\n")}`;
}

/** List every dependency whose resolved target has aged into a safe update. */
export function listSafeUpgrades(
	ecosystems: DependencyEcosystem[],
	updates?: ReadonlyMap<string, UpdateStatus>,
): SafeUpgrade[] {
	if (!updates) {
		return [];
	}

	const upgrades: SafeUpgrade[] = [];
	for (const eco of ecosystems) {
		for (const file of eco.files) {
			for (const dep of file.dependencies) {
				const status = updates.get(dep.name);
				if (status?.target) {
					upgrades.push({
						ecosystem: eco.ecosystem,
						manifest: file.file,
						package: dep.name,
						current: status.current,
						target: status.target,
						updateType: status.updateType,
					});
				}
			}
		}
	}
	return upgrades;
}
