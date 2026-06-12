# uppy

A paranoid, Renovate-compatible dependency update bot. It reads a repository's
Renovate configuration and manifests, decides which dependencies have aged into
a safe update, and reports them on a Dependency Dashboard.

## Language

**Manager**:
The file-reading half of an update check: the thing that parses a family of
manifests (`npm`/`package.json`, `mise`/`mise.toml`, `github-actions`/workflow
files). A Manager may tag different dependencies with different Datasources;
`mise` remains one Manager even when its tools resolve through `core`, `github`,
`aqua`, or `npm`. Renovate's manager vocabulary.
_Avoid_: ecosystem (the old fused term), parser, extractor

**Manager workflow**:
A Cloudflare Workflow class co-located with a Manager (`MiseWorkflow` beside
`miseManager`, `NpmWorkflow` beside `npmManager`, `GithubActionsWorkflow` beside
`githubActionsManager`), dispatched once per Safe upgrade by the orchestrator. It
owns the Manager-specific update command, the commit message, and the full
e2b-sandboxed clone → update → commit → push → PR cycle for that one upgrade. The
Manager interface stays about detection; the Manager workflow is the acting half.
_Avoid_: per-update workflow, update worker

**Datasource**:
The source of a dependency's version metadata — its released versions, publish
times, and `latest`. Independent of any one Manager: `github-tags` resolves
GitHub Actions, `github-releases` resolves GitHub-backed mise tools, and `npm`
resolves both package manifests and npm-backed mise tools. Renovate's
`matchDatasources` vocabulary.
_Avoid_: VersionSource, registry client, provider

**Update check**:
The decision pass between a Manager (files) and its Datasources (remote version
metadata): for one Manager's detected dependencies it flattens the files, skips
Unsupported dependencies, routes each dependency to its Datasource (the Manager
default or a per-dependency override), looks them up in parallel, and merges the
results into one update status per dependency. Owns the general recommendation
policy — Minimum release age, `ignoreUnstable`, `respectLatest`.
`fetchUpdateCheckForManager` runs it over one Manager dependency group.
_Avoid_: update plan (implies scheduling or branch dispatch), resolver

**Mise backend**:
The plain full source identity behind a mise tool, such as `core:node`,
`aqua:aws/aws-cli`, `github:endevco/aube`, or `npm:@openai/codex`.
uppy shows this full identity to users and uses the backend-specific name only
when asking a Datasource for version metadata.
_Avoid_: mise datasource, mise provider

**Unsupported dependency**:
A manifest entry uppy recognises but deliberately cannot update, such as an
unprefixed mise tool shorthand or decorated mise backend identity. It is shown
for user awareness, not resolved.
_Avoid_: missing dependency, ignored dependency

**Versioning**:
The scheme a Datasource uses to compare versions, classify a bump, and judge
stability. `npm` and `mise` use plain semver; `github-tags` tolerates a leading
`v` and reads a coarse tag (`v4`) as a moving track. Renovate's `versioning`
vocabulary.
_Avoid_: semver (only one of the schemes), format, scheme

**Minimum release age**:
How old a published version must be before uppy will recommend updating to it.
uppy enforces a paranoid 3-day floor even when config asks for less.
_Avoid_: cooldown, quarantine, age gate

**Digest pin**:
A GitHub Action referenced by its exact commit sha with the tag kept as a
trailing `# comment` track (`@<sha> # v4.1.0`). uppy treats the sha as
authoritative and recommends pinning every unpinned action regardless of config.
Distinct from the npm range pin (`:pinDevDependencies`), which exacts a range like
`^1.2.3` and involves no sha.
_Avoid_: pin (ambiguous with the range pin), lock, freeze

**Vulnerability alert**:
A known-vulnerability advisory affecting a detected dependency, drawn from
advisory sources (OSV and GitHub/Dependabot) and surfaced on the Dependency
Dashboard for user awareness. Orthogonal to a Datasource, which supplies version
metadata, not security advisories — a dependency can be perfectly up to date and
still carry a Vulnerability alert. Renovate's vulnerability-alert vocabulary.
_Avoid_: Datasource (versions, not advisories), CVE (one identifier scheme among
several), security warning

**Manager workflow**:
A Cloudflare Workflow class co-located with a Manager (`MiseWorkflow` in
`src/managers/mise.ts`, etc.), dispatched once per safe upgrade of that
Manager. Receives an `UpgradeParams` payload from `UppyWorkflow`, runs the
full sandbox → commit → push → PR cycle in a single workflow instance, and
exits with the result. The orchestrator does not know what a Manager workflow
does internally — it only knows which binding to call.
_Avoid_: per-update workflow (one instance per safe upgrade is a *single*
Manager workflow instance, not a separate class), update worker

**Instance ID**:
The Cloudflare Workflow instance identifier. The main orchestrator run uses
`<org>-<repo>-<nanoid>`. Each Manager workflow instance uses
`<main-instance-id>-<manager>-<nanoid>` — the manager name only, never the
package or group name. The ID is included in every PR description as
operational metadata for debugging Cloudflare Workflow runs.
_Avoid_: workflow id (ambiguous with the binding name)
