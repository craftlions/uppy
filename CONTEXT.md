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

**Datasource**:
The source of a dependency's version metadata — its released versions, publish
times, and `latest`. Independent of any one Manager: `github-tags` resolves
GitHub Actions, `github-releases` resolves GitHub-backed mise tools, and `npm`
resolves both package manifests and npm-backed mise tools. Renovate's
`matchDatasources` vocabulary.
_Avoid_: VersionSource, registry client, provider

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

**Update check**:
The decision pass that compares detected dependencies with Datasource metadata
and produces each dependency's update status.
_Avoid_: update plan, resolution pass

**Digest pin**:
A GitHub Action referenced by its exact commit sha with the tag kept as a
trailing `# comment` track (`@<sha> # v4.1.0`). uppy treats the sha as
authoritative and recommends pinning every unpinned action regardless of config.
Distinct from the npm range pin (`:pinDevDependencies`), which exacts a range like
`^1.2.3` and involves no sha.
_Avoid_: pin (ambiguous with the range pin), lock, freeze
