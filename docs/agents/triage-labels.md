# Triage Labels

Not applicable. This repo has no issue tracker (see `issue-tracker.md`), so there are no triage states to record as labels.

For reference, the `triage` skill's state machine speaks in five canonical roles:

| Role              | Meaning                                  |
| ----------------- | ---------------------------------------- |
| `needs-triage`    | Maintainer needs to evaluate this issue  |
| `needs-info`      | Waiting on reporter for more information |
| `ready-for-agent` | Fully specified, ready for an AFK agent  |
| `ready-for-human` | Requires human implementation            |
| `wontfix`         | Will not be actioned                     |

If you adopt an issue tracker later, re-run `/setup-matt-pocock-skills` (or edit this file) to map each role to the label string your tracker actually uses.
