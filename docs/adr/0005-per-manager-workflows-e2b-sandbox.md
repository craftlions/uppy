# Per-Manager workflows, e2b-sandboxed upgrades

uppy opens a pull request for a Safe upgrade by dispatching one **Manager
workflow** instance per upgrade — a Cloudflare Workflow class co-located with the
Manager it serves (`MiseWorkflow` next to `miseManager`, `NpmWorkflow` next to
`npmManager`, `GithubActionsWorkflow` next to `githubActionsManager`). The
orchestrator (`UppyWorkflow`) resolves the run-level context once, mints a single
short-lived installation token, and routes each upgrade through a literal
manager-to-binding map. A Manager missing from the map throws at the dispatch
seam rather than being silently dropped; a Manager whose update mechanism is not
yet wired (initially github-actions) stays on the map but is filtered out of
dispatch, so the dashboard stays accurate without running no-op work.

Each Manager workflow owns the full sandbox → commit → push → PR cycle in one
instance. It runs inside an [e2b](https://e2b.dev) sandbox booted from the
published template `craftlions/uppy-base` (the single source of truth for the
template name). The worker passes the installation token to the sandbox only as
inline credentials on the `git clone` call (`username: "x-access-token"`,
`password: <installationToken>`); e2b strips these credentials from the remote
URL after cloning, so no on-disk copy remains. The `dangerouslyAuthenticate`
credential-helper write is deliberately **not** called — the token must never
persist inside the sandbox because the untrusted update command runs next with
internet access, and publishing happens via the GitHub API from the worker (the
sandbox never needs the token again after the clone). The bot's git identity
(`craftlions-uppy[bot]`) is configured separately. The sandbox clones the
repository to `/home/user/workspace`, applies the Manager's update (mise edits
the `[tools]` version in `mise.toml` directly — preserving the full backend key
`"core:node"`/`"github:…"` that `mise use` would corrupt — then runs
`mise trust -y && mise install` to validate and refresh `mise.lock`; npm runs the
hermetic `mise exec … aube add`, with `--dev` for devDependencies), commits with
`--signoff` and a
`chore(deps): …` subject, and force-pushes with `--force-with-lease` to the same
`uppy/<manager>-<package>-<target>` branch so re-runs rebase rather than
clobber and the PR number is preserved. A "no changes" outcome throws — no
`--allow-empty` — so an "up to date" rerun never opens an empty PR. The sandbox
is always killed in a `finally`.

The sandbox writes `/home/user/workspace/result.json` (`commitSha`, `branch`, `diff`,
`filesChanged`); the worker reads it back as the single source for the PR body — a
structured header (Package, From, To, Manifest, Bump type) plus an inline diff and
a link to the Dependency Dashboard issue. The closed-PR short-circuit lives inside
the Manager workflow (in a `step.do`, so it retries): a closed PR for the branch
returns `"no-op"`, an open PR is updated, and the absence of a PR creates one.

## Considered Options

- **`@cloudflare/sandbox`** — rejected and removed. The Cloudflare Sandbox path
  was abandoned; e2b is the only sandbox surface, a single dependency.
- **One shared update workflow keyed on a `manager` string** — rejected. A single
  binding makes a mise, npm, and github-actions update indistinguishable to the
  dispatcher and to the observability timeline. Per-Manager bindings
  (`uppy-mise`, `uppy-npm`, `uppy-github-actions`) give each Manager its own
  timeline and let the update command, commit message, and lifecycle live next to
  the Manager's detection logic.
- **A long-lived or per-child token** — rejected. The orchestrator mints one
  short-lived installation token per run and threads it to every child, so the
  audit trail is per-installation and the credentials do not outlive the run.
- **Persist credentials for reuse via `dangerouslyAuthenticate`** — rejected.
  The credential-helper write left an on-disk copy of the installation token
  inside the sandbox that a malicious dependency's install scripts could read
  and exfiltrate. The clone already authenticates with inline credentials, and
  publishing happens via the GitHub API from the worker, so persistence was
  pure redundancy.
- **Scrub-after (authenticate-then-clear)** — rejected in favor of never-persist.
  A scrub leaves a window between persist and clear, and e2b does not cleanly
  document the teardown path. Never persisting closes the window entirely.
- **`--ignore-scripts` / scripts-disabled** — deliberately dropped from scope.
  Token removal fully closes the token-exfiltration threat. The residual risk
  that an install script runs arbitrary code (e.g. exfiltrating cloned repo
  contents, or writing files staged into the PR) is bounded by the sandbox
  lifecycle (always killed in `finally`), human diff review of the PR, and the
  Minimum release age 3-day floor, which is uppy's actual supply-chain
  prevention.

## Consequences

- Adding a Manager is a one-line change to the dispatch map plus a co-located
  workflow class and a `wrangler.jsonc` binding.
- `E2B_API_KEY` is a new Cloudflare secret (not a `vars` entry), because the key
  is sensitive and must not live in the worker source.
- The Manager interface stays focused on detection; the per-Manager workflow is a
  separate concern in the same module.
- The github-actions workflow is a deferred stub returning `"no-op"` until an
  `aube action` subcommand exists; until then the orchestrator never dispatches
  it.
- Transient failures (network blips, sandbox spin-up timeouts) ride Cloudflare's
  default `step.do` retries; permanent failures (a non-zero update command, an
  empty diff) surface loudly in the workflow dashboard. There is no separate
  persistence layer for reporting.
