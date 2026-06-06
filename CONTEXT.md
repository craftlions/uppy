# uppy

A paranoid, Renovate-compatible dependency update bot. It reads a repository's
Renovate configuration and manifests, decides which dependencies have aged into
a safe update, and reports them on a Dependency Dashboard.

## Language

**Manager**:
The file-reading half of an update check: the thing that parses a family of
manifests (`npm`/`package.json`, `mise`/`mise.toml`, `github-actions`/workflow
files) and tags each dependency with the Datasource that resolves it. Renovate's
manager vocabulary.
_Avoid_: ecosystem (the old fused term), parser, extractor

**Datasource**:
The source of a dependency's version metadata — its released versions, publish
times, and `latest`. Independent of any one Manager: `github-tags` resolves what
the `github-actions` manager extracts, while `npm` and `mise` pair with their
like-named managers. Renovate's `matchDatasources` vocabulary.
_Avoid_: VersionSource, registry client, provider

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
