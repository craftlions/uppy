# Per-manager workflows, e2b sandbox, force-push rebase

Each safe upgrade runs in its own Cloudflare Workflow instance, co-located with the Manager that produced it (`MiseWorkflow` in `src/managers/mise.ts`, `NpmWorkflow` in `src/managers/npm.ts`, `GithubActionsWorkflow` in `src/managers/github-actions.ts`). The instance creates an e2b sandbox from the published template `craftlions/uppy-base`, configures the bot identity, clones the repository to `/workspace`, runs the Manager's static update command, commits with `--signoff` and a `chore(deps): ...` message, force-pushes with `--force-with-lease` to the same `uppy/<manager>-<package>-<target>` branch on re-runs, and opens or updates the PR with a structured metadata header plus an inline diff. The orchestrator at `src/workflows/uppy.ts` knows only the manager-to-binding map; the per-manager workflow owns its own sandbox lifecycle, its own GitHub auth (`GIT_USERNAME=x-access-token` + a short-lived installation token in `GIT_TOKEN`), and its own `result.json` handoff. github-actions is deferred — its workflow exists but returns early with "no update command wired up yet" until an `aube action` subcommand is available.

## Considered Options

- **Cloudflare Sandbox (`@cloudflare/sandbox`)** — already a dependency, no new external service. Rejected in favour of e2b because the user's roadmap points at e2b and the surrounding tooling (templates, observability, multi-language) is broader; the swap is a `wrangler.jsonc` change plus an import swap, so the cost of being wrong is small.
- **Generic `UpgradeWorkflow` instead of per-manager classes** — fewer `wrangler.jsonc` entries, one shared retry timeline. Rejected because each Manager's failure mode is observable independently in the Cloudflare dashboard, and the per-manager file layout lets the update-command knowledge live next to the detection knowledge.
- **Skip-on-conflict instead of force-push rebase** — refuse to push when the branch already has commits, open a new branch. Rejected because it produces PR spam and breaks the `:rebaseStalePrs` default the user wants.

## Consequences

- `wrangler.jsonc` gains `uppy-npm` and `uppy-github-actions` workflow bindings; the `MISE_WORKFLOW` binding stays (renamed if needed for consistency).
- `package.json` gains `e2b` and drops `@cloudflare/sandbox`; the commented `SANDBOX_TRANSPORT` in `wrangler.jsonc` is removed.
- The e2b template `craftlions/uppy-base` is a separate artefact (Dockerfile + `e2b template build`) maintained outside the worker source. The template name is the single source of truth in `src/workflows/sandbox.ts`.
- The closed-PR short-circuit stays inside the per-manager workflow (not the orchestrator) so it can use `step.do` retries. Branches with a closed PR are no-ops; everything else force-pushes to the same branch and `pulls.update`s the existing PR or `pulls.create`s a new one.
- Empty commits fail loudly: the e2b SDK's `sandbox.git.commit` does not pass `--allow-empty`, so a "no changes" outcome surfaces as a workflow failure rather than a stale empty PR.
- `result.json` at `/workspace/result.json` is the sandbox-to-worker handoff. The schema is `{ commitSha, branch, diff, filesChanged }`; the worker reads it via `sandbox.files.read` and uses it to compose the PR body and the dashboard update.
