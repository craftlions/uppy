# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase. This repo uses a **single-context** layout.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root — the domain glossary (Manager, Datasource, Mise backend, Versioning, Minimum release age, Digest pin, …).
- **`docs/adr/`** — architectural decisions for the repo. Read the ADRs that touch the area you're about to work in.

If any of these files don't exist yet, **proceed silently**. Don't flag their absence or suggest creating them upfront. The producer skill (`/grill-with-docs`) creates them lazily when terms or decisions actually get resolved.

## File structure

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-big-endian-naming.md
│   ├── 0002-manager-datasource-versioning-registries.md
│   ├── 0003-github-action-digest-pinning.md
│   └── 0004-mise-backend-datasources.md
└── src/
```

If the repo ever needs to split into multiple bounded contexts, `/grill-with-docs` will introduce `CONTEXT-MAP.md` at the root and per-context `CONTEXT.md` / `docs/adr/` directories at that point. Until then this stays single-context.

## Use the glossary's vocabulary

When your output names a domain concept (an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids — each entry's `_Avoid_:` line is the list of terms to *not* use.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/grill-with-docs`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0002 (first-class managers, datasources, and versioning) — but worth reopening because…_
