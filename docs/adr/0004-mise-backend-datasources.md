# Mise backend datasources

Mise tools stay under the `mise` manager, but full mise backend identities choose the datasource per dependency: `core:*` uses the existing mise-versions data for now, `github:*` uses GitHub releases, `npm:*` uses the shared npm datasource, and `aqua:*` follows aqua-renovate-config's Renovate mapping rules. Unprefixed or decorated mise tools are reported as unsupported instead of being expanded through `mise registry`, because remote update results should not depend on a local mise installation or host configuration.
