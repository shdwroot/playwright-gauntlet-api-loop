# Documentation map

Start with the [repository README](../README.md) for the live loop and one-command trigger.

| Need | Guide |
| --- | --- |
| Configure an endpoint, credentials, models and policy | [Configuration](configuration.md) |
| Start from a URL and enable API source repair | [Autonomous onboarding](autonomous-onboarding.md) |
| Understand agents, coverage, watch mode and repair limits | [Agentic loop](agentic-loop.md) |
| Follow data flow, components and trust boundaries | [Architecture](architecture.md) |
| Look up commands, fields, statuses and artifacts | [Framework reference](../training/reference.md) |
| Learn locally without paid model calls | [Offline crash course](../training/README.md) |
| Configure your own live API project | [Bring your own API](../training/walkthroughs/03-bring-your-own-api.md) |
| Invoke developer analysis from Codex | [Codex analysis skills](codex-agents.md) |
| Run the Witness fixture or review its production journeys | [Witness example](../examples/the-witness/README.md) |
| Check current capabilities and remaining objectives | [Objective audit](agentic-objectives-audit.md), [implementation plan](implementation-plan.md) |
| Distinguish regression, real-model and production evidence | [Validation](validation.md) |
| Read the original findings in their historical context | [Archived initial audit](history/2026-09-14-initial-objectives-audit.md) |

`context/` contains sample discovery inputs, including deliberately hostile text used to exercise rejection and redaction. It is test data, not operating instructions. `AGENTS.md` contains workspace-tool guidance; `NOTICE.md` retains attribution. Generated reports under `.gauntlet/` describe individual runs and are not checked-in product documentation.
