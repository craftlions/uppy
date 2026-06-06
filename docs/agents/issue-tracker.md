# Issue tracker: None

This repo does not use an issue tracker. Work is not tracked as GitHub or GitLab issues, and there is no `.scratch/` local-markdown convention in use.

## What skills should do

Skills that expect to read from or write to an issue tracker — `to-issues`, `triage`, `to-prd`, `qa` — have no backing store here.

- **When a skill says "publish to the issue tracker":** stop and ask the maintainer where the output should go (a file, a PR description, a commit message) instead of guessing.
- **When a skill says "fetch the relevant ticket":** ask the maintainer to paste the requirement or context directly; there is nothing to fetch.

## Changing this later

If you adopt a tracker, edit this file or re-run `/setup-matt-pocock-skills`. The skill supports GitHub Issues (`gh`), GitLab Issues (`glab`), or local markdown under `.scratch/` out of the box.
