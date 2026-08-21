# 0001 — Per-project endpoint selection via a local file

## Status

Accepted

## Context

The extension automatically connects, for every project, all endpoints defined in the global config. This brings the tools of every open IDE into the system prompt, even when a project uses only one. We need a way to choose, per project, which IDE to reference.

## Decision

The selection lives in a `.pi/jetbrains.json` file at the project root (resolved via `process.cwd()`), containing only a whitelist of ids referencing endpoints defined in the global config. No inline URL or header definitions: the global config remains the single source of truth for connectivity.

The selection filters coherently across boot and commands. Missing file = fallback to all endpoints; file present with an empty list = no endpoints. An unknown id produces a warning and is skipped, without invalidating the others.

## Alternatives considered

- **Project→endpoint map in the global config**: rejected because absolute paths are fragile (renames, different machines) and the project→IDE binding is a property of the project, not of the machine.
- **References + inline definitions in the project file**: rejected because it would create two sources of truth for URLs/headers and risk versioning local ports in team-shared files.

## Consequences

- The project file is safe to version control: it contains only ids.
- Configuration spans two levels (global for connectivity, local for activation): readers must understand both files to know which tools will be available.
- The semantics of "missing file" vs "empty list" differ and must be documented explicitly.
