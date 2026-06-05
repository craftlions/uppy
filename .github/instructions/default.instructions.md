---
description: Default
applyTo: '**'
---

## Setup

Run these commands before making changes:

```shell
mise i
aube ci
```

## Hard Requirements

- Never run a dev server; assume one is already running.

## Validation

Run these commands after making changes:

```shell
aubr coverage
aubx biome check
```
