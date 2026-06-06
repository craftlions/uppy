# GitHub Action digest pinning, sha as ground truth

uppy recommends pinning every GitHub Action to the exact commit sha its tag
resolves to — converting `@v4.1.0` into `@<sha> # v4.1.0` — for every unpinned
action, regardless of config, the same way it forces a 3-day minimum release age
regardless of config. When an action is already sha-pinned, the sha is treated as
authoritative and the trailing `# v4.1.0` comment is cosmetic: uppy reverse-
resolves the sha to a tag rather than trusting the comment, because the comment is
attacker-controllable and the sha is what GitHub actually checks out. The single
recommendation carries both the target version and its target digest, so the
comment and the sha can never disagree. The minimum-release-age timestamp for a
tag is its target commit's date (preferring a GitHub Release `published_at` when
one exists); this holds the realistic attack — a moved tag pointing at a fresh
malicious commit — while staying available for tags that never cut a release.

## Considered Options

- **Config-driven pinning** (mirror Renovate's opt-in `pinDigests`) — rejected as
  less paranoid than uppy's other forced defaults.
- **Trust the `# comment` as the current version** — rejected: a stale or
  malicious comment would misreport what is actually pinned.

## Consequences

- Digest-pinning the *current* version is never age-gated; only advancing to a
  newer tag is, so an unpinned-but-current action is pinned immediately even while
  a newer tag is held.
- A sha that matches no tag is reported as pinned with an unknown version and
  carries no update recommendation.
