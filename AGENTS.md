# Workspace Agent Notes

## GBrain Configuration (configured by /setup-gbrain)
- Mode: local-stdio
- Engine: pglite
- Config file: ~/.gbrain/config.json (mode 0600)
- Setup date: 2026-09-12
- MCP registered: yes (user scope)
- Artifacts sync: full
- Current repo policy: read-write

## GBrain Search Guidance (configured by /sync-gbrain)
<!-- gstack-gbrain-search-guidance:start -->

GBrain is set up and synced on this machine. The agent should prefer gbrain
over Grep when the question is semantic or when the exact identifier is not
known yet. Two indexed corpora are available through the `gbrain` CLI:

- This repository's code, registered as `gstack-code-loop-37d6ae2a-931d32`.
- `~/.gstack/` curated memory, registered through the existing federation pipeline.

Prefer gbrain for semantic intent, symbol definitions and references, caller or
callee relationships, and prior project decisions. Grep is still right for
known exact strings, regular expressions, multiline patterns, and file globs.
Run `/sync-gbrain` to refresh incrementally or `/sync-gbrain --full` to reindex.

<!-- gstack-gbrain-search-guidance:end -->
