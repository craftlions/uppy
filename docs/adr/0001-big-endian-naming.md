# Big-endian identifier naming

Identifiers lead with the most significant word and append qualifiers in
decreasing significance, so related names share a prefix and sort together:
`fetchOutdated` / `fetchOutdatedNpm` / `fetchOutdatedMise`, and
`datasourceNpm` / `datasourceMise` — not `fetchNpmOutdated` or `npmDatasource`.
We accept reduced English readability in exchange for grouping and
prefix-searchability. Applies to functions, variables, and types across the
codebase.

This does not conflict with the Biome configuration, which governs formatting,
not identifier word-order.
