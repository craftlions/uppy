---
description: Biome formatting and lint rules for project files
applyTo: "**/*.{ts,tsx,js,jsx,json,jsonc,md,yml,yaml,css,html}"
---

- Follow the repository Biome configuration in `biome.jsonc`; do not introduce separate formatting conventions.
- Keep imports organized according to Biome assist rules.
- Preserve ASCII text unless a file already uses non-ASCII content or the change specifically requires it.
- After changing files covered by this instruction, run `aubx biome check` from the repository root.
