# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase. This repo uses a **multi-context** layout.

## Before exploring, read these

- **`CONTEXT-MAP.md`** at the repo root — it points at one `CONTEXT.md` per context. Read each one relevant to the topic you're working on.
- **`CONTEXT.md`** files (root and/or per-context under `src/<context>/`) for the domain glossary.
- **`docs/adr/`** — system-wide architectural decisions. Also check **`src/<context>/docs/adr/`** for context-scoped decisions in the area you're about to work in.

If any of these files don't exist yet, **proceed silently**. Don't flag their absence or suggest creating them upfront. The producer skill (`/grill-with-docs`) creates them lazily when terms or decisions actually get resolved.

> Note: today the repo has a single root `CONTEXT.md` and no `CONTEXT-MAP.md` yet. As the project grows into separate contexts, `/grill-with-docs` will introduce `CONTEXT-MAP.md` and per-context `CONTEXT.md` files. Read whatever is present.

## File structure (multi-context)

```
/
├── CONTEXT-MAP.md                      ← points to per-context CONTEXT.md files
├── CONTEXT.md                          ← root/system glossary (present today)
├── docs/adr/                           ← system-wide decisions
└── src/
    ├── <context-a>/
    │   ├── CONTEXT.md
    │   └── docs/adr/                   ← context-specific decisions
    └── <context-b>/
        ├── CONTEXT.md
        └── docs/adr/
```

## Use the glossary's vocabulary

When your output names a domain concept (an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in the relevant `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/grill-with-docs`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…_
