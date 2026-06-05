---
paths:
  - "src/**/*.ts"
  - "test/**/*.ts"
  - "vitest.config.ts"
---

- Add or update focused Vitest coverage in `test/` when behavior in `src/` changes.
- Keep tests deterministic and avoid depending on a local dev server.
- Prefer assertions against returned values, errors, and observable side effects over implementation details.
- After changing source, tests, or Vitest configuration, run `aubr coverage` from the repository root.
