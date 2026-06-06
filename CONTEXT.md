# uppy

A paranoid, Renovate-compatible dependency update bot. It reads a repository's
Renovate configuration and manifests, decides which dependencies have aged into
a safe update, and reports them on a Dependency Dashboard.

## Language

**Datasource**:
The interface uppy fetches version metadata through for one ecosystem — given a
set of dependency names, it returns each one's released versions, their publish
times, and the `latest` version. `npm` and `mise` are the two adapters. Mirrors
Renovate's `matchDatasources` vocabulary.
_Avoid_: VersionSource, registry client, provider

**Minimum release age**:
How old a published version must be before uppy will recommend updating to it.
uppy enforces a paranoid 3-day floor even when config asks for less.
_Avoid_: cooldown, quarantine, age gate
