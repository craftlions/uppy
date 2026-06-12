import type { OsvVulnerabilityAlert } from "./osv.ts";
import type { EffectiveMinimumReleaseAge } from "./outdated.ts";
import type { DependabotAlert } from "./vulnerability-alerts.ts";
import {
	type Dependency,
	dependencyKey,
	type ManagerDependencies,
	type UpdateRecord,
	type UpdateStatus,
} from "./deps.ts";

/**
 * A pin action targeting a single Detected Dependency, scoped by Manager,
 * manifest, and package. The dashboard flags the matching row with a `📌 pin`
 * action; the same package in a different manifest or Manager is left alone.
 */
export interface PinAction {
	manager: string;
	manifest: string;
	package: string;
}

/** Everything the Dependency Dashboard needs to render its full issue body. */
export interface DependencyDashboardInput {
	/** When the dashboard was assembled; rendered with `toISOString()`. */
	updatedAt: Date;
	/** The effective minimum release age; its note renders only when forced. */
	minimumReleaseAge: EffectiveMinimumReleaseAge;
	/** Detected dependencies per Manager, rendered as one table each. */
	managerDependencies: ManagerDependencies[];
	/**
	 * Update status per Manager, keyed by Manager name. A detected Manager group
	 * with no pending updates maps to an empty record (rendered as up to date)
	 * rather than being omitted.
	 */
	updatesByManager: Partial<Record<string, UpdateRecord>>;
	/**
	 * Resolved Renovate `groupName` per dependency, keyed by Manager name and then
	 * package name. When present, the npm/mise sections are rendered with group
	 * sub-headers instead of one flat table.
	 */
	groups?: Record<string, Record<string, string>>;
	/** Scoped pin actions to flag on matching dependency rows. */
	pins?: PinAction[];
	/** Open GitHub vulnerability alerts. */
	vulnerabilityAlerts: DependabotAlert[];
	/** OSV vulnerability alerts for detected npm dependencies. */
	osvAlerts: OsvVulnerabilityAlert[];
}

const UP_TO_DATE = "✅ up to date";
const PIN = "📌 pin";
const PIN_DIGEST = "📌 pin digest";

/** Managers whose tables gain `Target`/`Update` columns. */
const UPDATABLE_MANAGERS = new Set(["npm", "mise"]);

/** The leading bytes of a commit sha, as GitHub abbreviates them. */
const shortSha = (sha: string): string => sha.slice(0, 7);

const countDependencies = (group: ManagerDependencies): number =>
	group.files.reduce((sum, file) => sum + file.dependencies.length, 0);

/** A stable key identifying a Detected Dependency for scoped pin lookups. */
const pinKey = (manager: string, manifest: string, pkg: string): string =>
	`${manager}\u0000${manifest}\u0000${pkg}`;

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
	unsupportedReason?: string,
): {
	target: string;
	update: string;
} {
	if (unsupportedReason) {
		return { target: "—", update: `ℹ️ unsupported (${unsupportedReason})` };
	}
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

/** Render a plain `Package | Version | Manifest` table for a Manager group. */
function renderPlainSection(group: ManagerDependencies): string {
	const rows = group.files
		.flatMap((file) =>
			file.dependencies.map(
				(dep) => `| \`${dep.name}\` | \`${dep.version}\` | \`${file.file}\` |`,
			),
		)
		.join("\n");
	return `### ${group.manager} (${countDependencies(group)})\n\n| Package | Version | Manifest |\n| --- | --- | --- |\n${rows}`;
}

/**
 * Render a Manager group with extra `Target` and `Update` columns, flagging the
 * deps that Renovate's default policy would bump. Deps without an entry in
 * `updates` are shown as up to date. Rows whose scoped identity is in `pinned`
 * additionally get a `📌 pin` action.
 *
 * When `groups` contains entries for this Manager, dependencies are split into
 * group sub-sections (each with its own table) plus an "Ungrouped" section for
 * deps that do not belong to any group.
 */
function renderUpdatableSection(
	group: ManagerDependencies,
	updates: Readonly<UpdateRecord>,
	pinned: ReadonlySet<string>,
	groups?: Readonly<Record<string, string>>,
): string {
	const header = `### ${group.manager} (${countDependencies(group)})`;

	if (!groups || Object.keys(groups).length === 0) {
		const rows = group.files
			.flatMap((file) =>
				file.dependencies.map((dep) =>
					renderUpdatableRow(group.manager, file.file, dep, updates, pinned),
				),
			)
			.join("\n");
		return `${header}\n\n| Package | Current | Target | Update | Manifest |\n| --- | --- | --- | --- | --- |\n${rows}`;
	}

	const grouped = new Map<string, string[]>();
	const ungrouped: string[] = [];
	for (const file of group.files) {
		for (const dep of file.dependencies) {
			const row = renderUpdatableRow(
				group.manager,
				file.file,
				dep,
				updates,
				pinned,
			);
			const groupName = groups[dep.name];
			if (groupName) {
				const list = grouped.get(groupName) ?? [];
				list.push(row);
				grouped.set(groupName, list);
			} else {
				ungrouped.push(row);
			}
		}
	}

	const parts = [header];
	for (const [groupName, rows] of grouped) {
		parts.push(
			`#### ${groupName}\n\n| Package | Current | Target | Update | Manifest |\n| --- | --- | --- | --- | --- |\n${rows.join("\n")}`,
		);
	}
	if (ungrouped.length > 0) {
		parts.push(
			`#### Ungrouped\n\n| Package | Current | Target | Update | Manifest |\n| --- | --- | --- | --- | --- |\n${ungrouped.join("\n")}`,
		);
	}
	return parts.join("\n\n");
}

function renderUpdatableRow(
	manager: string,
	manifest: string,
	dep: Dependency,
	updates: Readonly<UpdateRecord>,
	pinned: ReadonlySet<string>,
): string {
	const { target, update } = updateCells(
		updates[dep.name],
		pinned.has(pinKey(manager, manifest, dep.name)),
		dep.unsupportedReason,
	);
	return `| \`${dep.name}\` | \`${dep.version}\` | ${target} | ${update} | \`${manifest}\` |`;
}

/**
 * The `Current` cell for a github-action: its resolved version and, when pinned,
 * the abbreviated commit sha. The version comes only from the sha-resolved status
 * — never from the manifest's `# vX.Y.Z` comment, which is attacker-controllable
 * and which the datasource deliberately ignores. An already-pinned, up-to-date
 * action (no status) therefore shows just its sha; an unpinned ref shows the tag
 * the author wrote.
 */
function actionCurrentCell(
	dep: Dependency,
	status: UpdateStatus | undefined,
): string {
	const version = status?.current ?? (dep.pinned ? "" : dep.version);
	const sha = status?.currentDigest ?? (dep.pinned ? dep.version : undefined);
	const parts: string[] = [];
	if (version) {
		parts.push(`\`${version}\``);
	}
	if (sha) {
		parts.push(version ? `(\`${shortSha(sha)}\`)` : `\`${shortSha(sha)}\``);
	}
	return parts.length > 0 ? parts.join(" ") : `\`${dep.version}\``;
}

/**
 * The `Target` cell for a github-action: the version and sha uppy recommends
 * pinning to, or `—` when nothing is recommended (held with no pin, or already
 * pinned to the right sha).
 */
function actionTargetCell(status: UpdateStatus | undefined): string {
	if (!status) {
		return "—";
	}
	const moving = status.currentDigest !== status.targetDigest;
	const versionBump =
		status.target !== null && status.target !== status.current;
	if (!moving && !versionBump) {
		return "—";
	}
	const version = status.target ?? status.current;
	const digest = status.targetDigest
		? ` (\`${shortSha(status.targetDigest)}\`)`
		: "";
	return `\`${version}\`${digest}`;
}

/**
 * The `Update` cell for a github-action. A `digest` update type is a pure pin
 * with no version change (the sha is ground truth, so a pinned action's version
 * is resolved from its sha and can never disagree with it). A version change
 * reuses the shared safe/held wording and appends the pin action when the action
 * also needs pinning.
 */
function actionUpdateCell(status: UpdateStatus | undefined): string {
	if (!status) {
		return UP_TO_DATE;
	}
	if (status.updateType === "digest") {
		return PIN_DIGEST;
	}
	const update = updateStatusCells(status).update;
	const pinning =
		status.currentDigest === undefined && status.targetDigest !== undefined;
	return pinning ? `${update} ${PIN_DIGEST}` : update;
}

/**
 * Render the github-actions Manager. Unlike npm/mise the `Current` and `Target`
 * cells carry both a version and a commit sha, since uppy's recommendation is to
 * pin the action to the sha of the safest acceptable version.
 */
function renderGithubActionsSection(
	group: ManagerDependencies,
	updates: Readonly<UpdateRecord>,
): string {
	const rows = group.files
		.flatMap((file) =>
			file.dependencies.map((dep) => {
				const status = updates[dependencyKey(dep)];
				return `| \`${dep.name}\` | ${actionCurrentCell(dep, status)} | ${actionTargetCell(status)} | ${actionUpdateCell(status)} | \`${file.file}\` |`;
			}),
		)
		.join("\n");
	return `### ${group.manager} (${countDependencies(group)})\n\n| Action | Current | Target | Update | Workflow |\n| --- | --- | --- | --- | --- |\n${rows}`;
}

/**
 * Render detected dependencies as a Markdown table per Manager. The `npm` and
 * `mise` Managers gain `Target`/`Update` columns describing the Renovate-style
 * bump for each outdated dependency; `github-actions` gets its own version+sha
 * table. A detected Manager group with an empty update record still renders its
 * dependencies as up to date.
 */
function renderDetectedDependencies(
	managerDependencies: ManagerDependencies[],
	updatesByManager: Partial<Record<string, UpdateRecord>>,
	pinned: ReadonlySet<string>,
	groups?: Readonly<Record<string, Record<string, string>>>,
): string {
	if (managerDependencies.length === 0) {
		return "";
	}

	const sections = managerDependencies.map((group) => {
		const updates = updatesByManager[group.manager];
		if (group.manager === "github-actions") {
			return renderGithubActionsSection(group, updates ?? {});
		}
		return updates && UPDATABLE_MANAGERS.has(group.manager)
			? renderUpdatableSection(
					group,
					updates,
					pinned,
					groups?.[group.manager],
				)
			: renderPlainSection(group);
	});

	return `## Detected Dependencies\n\n${sections.join("\n\n")}`;
}

function renderUnsupportedDependencies(
	managerDependencies: ManagerDependencies[],
): string {
	const rows = managerDependencies
		.flatMap((group) =>
			group.files.flatMap((file) =>
				file.dependencies
					.filter((dep) => dep.unsupportedReason)
					.map(
						(dep) =>
							`> | \`${group.manager}/${dep.name}\` | \`${file.file}\` | ${dep.unsupportedReason} |`,
					),
			),
		)
		.join("\n");
	if (!rows) {
		return "";
	}
	return `> [!NOTE]
> Some detected dependencies are not supported by uppy yet.
>
> | Dependency | Manifest | Reason |
> | --- | --- | --- |
${rows}`;
}

/**
 * Render the GitHub `[!NOTE]` callout explaining that Uppy enforced its paranoid
 * 3-day minimum release age. Shown on top of the dashboard whenever the floor
 * was forced (the configured value was missing or below 3 days).
 */
function renderMinimumReleaseAgeNote(): string {
	return `> [!NOTE]
> Uppy enforces a paranoid minimum release age of **3 days** before recommending updates, to limit exposure to supply-chain attacks on freshly published versions. Newer releases are held back (⏳) until they age past this window.`;
}

/** Render GitHub vulnerability alerts as a warning block for the dashboard. */
function renderVulnerabilityAlerts(alerts: DependabotAlert[]): string {
	if (alerts.length === 0) {
		return "";
	}

	const rows = alerts
		.map((alert) => {
			const pkg = alert.dependency.package;
			const name = pkg ? `${pkg.ecosystem}/${pkg.name}` : "unknown";
			const manifest = alert.dependency.manifest_path ?? "unknown";
			const patched =
				alert.security_vulnerability.first_patched_version?.identifier;
			const fix = patched ? `\`${patched}\`` : "unavailable";
			return `> | \`${name}\` | \`${manifest}\` | \`${alert.security_advisory.severity}\` | [\`${alert.security_advisory.ghsa_id}\`](${alert.html_url}) | ${fix} |`;
		})
		.join("\n");

	return `> [!WARNING]
> GitHub reported vulnerability alerts for this repository.
>
> | Package | Manifest | Severity | Advisory | Patched |
> | --- | --- | --- | --- | --- |
${rows}`;
}

/** Render OSV alerts as a warning block for the dashboard. */
function renderOsvVulnerabilityAlerts(alerts: OsvVulnerabilityAlert[]): string {
	if (alerts.length === 0) {
		return "";
	}

	const rows = alerts
		.map((alert) => {
			const vulnerabilityIds = alert.vulnerabilities
				.map((vulnerability) => `\`${vulnerability.id}\``)
				.join(", ");
			return `> | \`${alert.dependency.name}\` | \`${alert.dependency.version}\` | ${vulnerabilityIds} |`;
		})
		.join("\n");

	return `> [!WARNING]
> OSV reported vulnerabilities for detected npm dependencies.
>
> | Package | Version | Vulnerabilities |
> | --- | --- | --- |
${rows}`;
}

/**
 * Render the full Dependency Dashboard issue body. Always returns a body, even
 * when no dependencies or alerts exist. Sections render in a fixed order: the
 * forced minimum release age note, GitHub vulnerability alerts, OSV vulnerability
 * alerts, the header, the detected dependency tables, then the timestamp at the
 * very bottom.
 */
export function renderDependencyDashboard(
	input: DependencyDashboardInput,
): string {
	const {
		updatedAt,
		minimumReleaseAge,
		managerDependencies,
		updatesByManager,
		groups,
		pins = [],
		vulnerabilityAlerts,
		osvAlerts,
	} = input;

	const pinned = new Set(
		pins.map((pin) => pinKey(pin.manager, pin.manifest, pin.package)),
	);

	const sections = [
		minimumReleaseAge.forced ? renderMinimumReleaseAgeNote() : "",
		renderVulnerabilityAlerts(vulnerabilityAlerts),
		renderOsvVulnerabilityAlerts(osvAlerts),
		renderUnsupportedDependencies(managerDependencies),
		"This issue lists Uppy updates and detected dependencies.",
		renderDetectedDependencies(
			managerDependencies,
			updatesByManager,
			pinned,
			groups,
		),
		`Last updated at ${updatedAt.toISOString()}`,
	];

	return sections.filter(Boolean).join("\n\n");
}
