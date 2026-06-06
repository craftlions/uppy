# First-class managers, datasources, and versioning

Adding GitHub Actions support broke uppy's fused "one ecosystem = one Datasource"
model: the `github-actions` manager parses workflow files, but version metadata
comes from a `github-tags` datasource, and Action tags (`v4`, `v4.1.0`) are not
plain semver. We split Manager (parses manifests, tags each dependency with a
datasource) from Datasource (fetches version metadata) as first-class,
registry-held concepts, introduced a Versioning abstraction so the resolver no
longer imports `semver` directly, and made the Datasource contract return each
dependency's resolved `current` version/digest rather than only candidate
versions. npm and mise were retrofitted onto the same structure even though their
manager and datasource names coincide.

## Considered Options

- **Minimal split** — tag dependencies with a datasource name but leave npm/mise
  fused and the resolver semver-only. Rejected: the coarse-tag and digest cases
  still leak ecosystem-specific logic into the shared core.
- **Normalize-to-semver at the datasource boundary** — keep the resolver pure
  semver and drop coarse `v4` tags to digest-only. Rejected: a repo pinned to
  `@v4` would never see a `v4→v5` suggestion.

## Consequences

- `Datasource.lookup` takes `{name, ref}[]` (not bare names) and returns
  `currentVersion`/`currentDigest`; npm/mise are trivial pass-throughs.
- Each Datasource declares its Versioning; the resolver is versioning-driven.
- See [0003](./0003-github-action-digest-pinning.md) for the sha-as-truth policy
  that rides on the resolved-current contract.
