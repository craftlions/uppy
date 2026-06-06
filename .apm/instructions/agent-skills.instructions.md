---
description: Engineering agent-skills configuration for this repo (issue tracker, triage labels, domain docs)
applyTo: "**"
---

## Agent skills

### Issue tracker

This repo does not use an issue tracker. Skills that create or read issues (`to-issues`, `triage`, `to-prd`, `qa`) should stop and ask the maintainer rather than guessing a backing store. See `docs/agents/issue-tracker.md`.

### Triage labels

Not applicable — without an issue tracker there are no triage states to label. See `docs/agents/triage-labels.md`.

### Domain docs

Multi-context layout: `CONTEXT-MAP.md` at the root points to per-context `CONTEXT.md` files, with ADRs under `docs/adr/` (system-wide) and `src/<context>/docs/adr/` (context-scoped). See `docs/agents/domain.md`.
