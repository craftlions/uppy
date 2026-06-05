---
description: Required project command workflow and local runtime constraints
applyTo: "**"
---

- Before making code, config, or documentation changes, run `mise i` and `aube ci` from the repository root.
- Use `aube`/`aubx`/`aubr` for project commands instead of adding another package manager workflow.
- Do not run a development server. Assume one is already running when local browser or runtime behavior needs to be checked.
- Keep generated dependency and tool files such as `mise.lock`, `aube-lock.yaml`, and `apm.lock.yaml` aligned with the command that intentionally updates them.
