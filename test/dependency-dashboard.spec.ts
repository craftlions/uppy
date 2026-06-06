import { describe, expect, it } from "vitest";
import {
	type DependencyDashboardInput,
	renderDependencyDashboard,
} from "../src/dependency-dashboard.ts";

const UPDATED_AT = new Date("2026-06-06T00:00:00.000Z");

/** Build a dashboard input with sensible empty defaults, overridable per test. */
function input(
	overrides: Partial<DependencyDashboardInput> = {},
): DependencyDashboardInput {
	return {
		updatedAt: UPDATED_AT,
		minimumReleaseAge: { ms: 0, forced: false },
		ecosystems: [],
		updatesByEcosystem: {},
		vulnerabilityAlerts: [],
		osvAlerts: [],
		...overrides,
	};
}

const githubAlert = {
	dependency: {
		manifest_path: "package-lock.json",
		package: { ecosystem: "npm", name: "left-pad" },
	},
	html_url: "https://github.com/acme/repo/security/dependabot/1",
	security_advisory: {
		ghsa_id: "GHSA-1234",
		severity: "high",
		summary: "Example advisory",
	},
	security_vulnerability: {
		first_patched_version: { identifier: "1.3.1" },
		vulnerable_version_range: "< 1.3.1",
	},
};

describe("renderDependencyDashboard", () => {
	it("always renders the header and timestamp", () => {
		expect(renderDependencyDashboard(input())).toMatchInlineSnapshot(`
      "This issue lists Uppy updates and detected dependencies.

      Last updated at 2026-06-06T00:00:00.000Z"
    `);
	});

	it("renders an empty dashboard when there are no dependencies or alerts", () => {
		const dashboard = renderDependencyDashboard(input());
		expect(dashboard).toContain(
			"This issue lists Uppy updates and detected dependencies.",
		);
		expect(dashboard).not.toContain("## Detected Dependencies");
		expect(dashboard).not.toContain("[!WARNING]");
		expect(dashboard).not.toContain("[!NOTE]");
	});

	it("renders the forced minimum release age note", () => {
		expect(
			renderDependencyDashboard(
				input({ minimumReleaseAge: { ms: 0, forced: true } }),
			),
		).toMatchInlineSnapshot(`
      "> [!NOTE]
      > Uppy enforces a paranoid minimum release age of **3 days** before recommending updates, to limit exposure to supply-chain attacks on freshly published versions. Newer releases are held back (⏳) until they age past this window.

      This issue lists Uppy updates and detected dependencies.

      Last updated at 2026-06-06T00:00:00.000Z"
    `);
	});

	it("renders GitHub vulnerability alerts", () => {
		expect(
			renderDependencyDashboard(input({ vulnerabilityAlerts: [githubAlert] })),
		).toMatchInlineSnapshot(`
      "> [!WARNING]
      > GitHub reported vulnerability alerts for this repository.
      >
      > | Package | Manifest | Severity | Advisory | Patched |
      > | --- | --- | --- | --- | --- |
      > | \`npm/left-pad\` | \`package-lock.json\` | \`high\` | [\`GHSA-1234\`](https://github.com/acme/repo/security/dependabot/1) | \`1.3.1\` |

      This issue lists Uppy updates and detected dependencies.

      Last updated at 2026-06-06T00:00:00.000Z"
    `);
	});

	it("renders OSV vulnerability alerts", () => {
		expect(
			renderDependencyDashboard(
				input({
					osvAlerts: [
						{
							dependency: { name: "left-pad", version: "1.3.0" },
							vulnerabilities: [{ id: "GHSA-1234" }, { id: "OSV-2026-1" }],
						},
					],
				}),
			),
		).toMatchInlineSnapshot(`
      "> [!WARNING]
      > OSV reported vulnerabilities for detected npm dependencies.
      >
      > | Package | Version | Vulnerabilities |
      > | --- | --- | --- |
      > | \`left-pad\` | \`1.3.0\` | \`GHSA-1234\`, \`OSV-2026-1\` |

      This issue lists Uppy updates and detected dependencies.

      Last updated at 2026-06-06T00:00:00.000Z"
    `);
	});

	it("renders detected dependency tables with up-to-date rows", () => {
		expect(
			renderDependencyDashboard(
				input({
					ecosystems: [
						{
							ecosystem: "mise",
							files: [
								{
									file: "mise.toml",
									dependencies: [{ name: "aube", version: "1.17.1" }],
								},
							],
						},
						{
							ecosystem: "npm",
							files: [
								{
									file: "package.json",
									dependencies: [{ name: "@octokit/core", version: "7.0.6" }],
								},
							],
						},
					],
					updatesByEcosystem: { mise: {}, npm: {} },
				}),
			),
		).toMatchInlineSnapshot(`
			"This issue lists Uppy updates and detected dependencies.

			## Detected Dependencies

			### mise (1)

			| Package | Current | Target | Update | Manifest |
			| --- | --- | --- | --- | --- |
			| \`aube\` | \`1.17.1\` | — | ✅ up to date | \`mise.toml\` |

			### npm (1)

			| Package | Current | Target | Update | Manifest |
			| --- | --- | --- | --- | --- |
			| \`@octokit/core\` | \`7.0.6\` | — | ✅ up to date | \`package.json\` |

			Last updated at 2026-06-06T00:00:00.000Z"
		`);
	});

	it("renders held, safe, and safe-newer-held update states", () => {
		expect(
			renderDependencyDashboard(
				input({
					ecosystems: [
						{
							ecosystem: "npm",
							files: [
								{
									file: "package.json",
									dependencies: [
										{ name: "uptodate", version: "1.0.0" },
										{ name: "safe", version: "1.0.0" },
										{ name: "newer-held", version: "1.0.0" },
										{ name: "held", version: "1.0.0" },
									],
								},
							],
						},
					],
					updatesByEcosystem: {
						npm: {
							safe: {
								current: "1.0.0",
								target: "1.1.0",
								updateType: "minor",
								state: "safe",
							},
							"newer-held": {
								current: "1.0.0",
								target: "1.1.0",
								updateType: "minor",
								state: "safe-newer-held",
								heldVersion: "1.2.0",
							},
							held: {
								current: "1.0.0",
								target: null,
								updateType: "minor",
								state: "held",
								heldVersion: "1.1.0",
							},
						},
					},
				}),
			),
		).toMatchInlineSnapshot(`
			"This issue lists Uppy updates and detected dependencies.

			## Detected Dependencies

			### npm (4)

			| Package | Current | Target | Update | Manifest |
			| --- | --- | --- | --- | --- |
			| \`uptodate\` | \`1.0.0\` | — | ✅ up to date | \`package.json\` |
			| \`safe\` | \`1.0.0\` | \`1.1.0\` | 🟢 minor (safe) | \`package.json\` |
			| \`newer-held\` | \`1.0.0\` | \`1.1.0\` | 🟢 minor (safe) ⏳ newer held (\`1.2.0\`) | \`package.json\` |
			| \`held\` | \`1.0.0\` | — | ⏳ minor held (\`1.1.0\`) | \`package.json\` |

			Last updated at 2026-06-06T00:00:00.000Z"
		`);
	});

	it("renders a pin action for a scoped Detected Dependency", () => {
		const dashboard = renderDependencyDashboard(
			input({
				ecosystems: [
					{
						ecosystem: "npm",
						files: [
							{
								file: "package.json",
								dependencies: [
									{
										name: "vitest",
										version: "4.1.7",
										pinned: false,
										depType: "devDependencies",
									},
								],
							},
						],
					},
				],
				updatesByEcosystem: { npm: {} },
				pins: [
					{ ecosystem: "npm", manifest: "package.json", package: "vitest" },
				],
			}),
		);

		expect(dashboard).toContain(
			"| `vitest` | `4.1.7` | — | 📌 pin | `package.json` |",
		);
	});

	it("does not apply a pin action to the same package in another manifest or ecosystem", () => {
		const dashboard = renderDependencyDashboard(
			input({
				ecosystems: [
					{
						ecosystem: "npm",
						files: [
							{
								file: "apps/web/package.json",
								dependencies: [
									{
										name: "vitest",
										version: "4.1.7",
										pinned: false,
										depType: "devDependencies",
									},
								],
							},
						],
					},
					{
						ecosystem: "mise",
						files: [
							{
								file: "mise.toml",
								dependencies: [{ name: "vitest", version: "4.1.7" }],
							},
						],
					},
				],
				updatesByEcosystem: { npm: {}, mise: {} },
				pins: [
					{ ecosystem: "npm", manifest: "package.json", package: "vitest" },
				],
			}),
		);

		expect(dashboard).not.toContain("📌 pin");
	});

	it("renders a plain table for an ecosystem without update support", () => {
		const dashboard = renderDependencyDashboard(
			input({
				ecosystems: [
					{
						ecosystem: "docker",
						files: [
							{
								file: "Dockerfile",
								dependencies: [{ name: "node", version: "26.3.0" }],
							},
						],
					},
				],
			}),
		);

		expect(dashboard).toContain("### docker (1)");
		expect(dashboard).toContain("| Package | Version | Manifest |");
		expect(dashboard).toContain("| `node` | `26.3.0` | `Dockerfile` |");
	});

	it("renders unsupported dependencies as an informational note", () => {
		const dashboard = renderDependencyDashboard(
			input({
				ecosystems: [
					{
						ecosystem: "mise",
						files: [
							{
								file: "mise.toml",
								dependencies: [
									{
										name: "node",
										version: "26.3.0",
										unsupportedReason:
											"mise shorthand is unsupported; use a full backend identifier",
									},
								],
							},
						],
					},
				],
				updatesByEcosystem: { mise: {} },
			}),
		);

		expect(dashboard).toContain(
			"> | `mise/node` | `mise.toml` | mise shorthand is unsupported; use a full backend identifier |",
		);
		expect(dashboard).toContain(
			"| `node` | `26.3.0` | — | ℹ️ unsupported (mise shorthand is unsupported; use a full backend identifier) | `mise.toml` |",
		);
	});

	it("renders the github-actions section with version+sha cells", () => {
		const shaA = "a".repeat(40);
		const shaB = "b".repeat(40);
		const dashboard = renderDependencyDashboard(
			input({
				ecosystems: [
					{
						ecosystem: "github-actions",
						files: [
							{
								file: ".github/workflows/ci.yml",
								dependencies: [
									{
										name: "actions/checkout",
										version: "v4.1.0",
										depType: "action",
										pinned: false,
									},
									{
										name: "actions/setup-node",
										version: shaA,
										depType: "action",
										pinned: true,
										comment: "v4.0.0",
									},
								],
							},
						],
					},
				],
				updatesByEcosystem: {
					"github-actions": {
						"actions/checkout@v4.1.0": {
							current: "v4.1.0",
							target: "v4.2.0",
							updateType: "minor",
							state: "safe",
							targetDigest: shaB,
						},
					},
				},
			}),
		);

		expect(dashboard).toContain("### github-actions (2)");
		expect(dashboard).toContain(
			"| Action | Current | Target | Update | Workflow |",
		);
		// Floating tag: pinned to the bumped version's sha.
		expect(dashboard).toContain(
			"| `actions/checkout` | `v4.1.0` | `v4.2.0` (`bbbbbbb`) | 🟢 minor (safe) 📌 pin digest | `.github/workflows/ci.yml` |",
		);
		// Already pinned and current: shows the ground-truth sha only — the
		// untrusted `# v4.0.0` comment is never rendered as the version.
		expect(dashboard).toContain(
			"| `actions/setup-node` | `aaaaaaa` | — | ✅ up to date | `.github/workflows/ci.yml` |",
		);
	});
});
