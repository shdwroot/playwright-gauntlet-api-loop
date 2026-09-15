# Developer analysis in Codex

For Codex, Claude Code and GitHub Copilot entry points, see the [shared IDE helper guide](ide-helpers.md).

This repository includes two callable Codex skills under `.agents/skills/`. They give the IDE assistant reusable analysis workflows. The Gauntlet runtime still owns its separate discovery, lead, builder, verifier, critic and healer model calls.

Open this repository in the Codex IDE extension and type `$` to select a skill. If it is missing, restart Codex. Repository skill discovery and explicit invocation follow the [official Codex skill documentation](https://developers.openai.com/codex/skills/).

For a new API:

```text
$gauntlet-api-analysis Analyze the contract at <OpenAPI URL> and the requirements at <local paths>. Prepare a local config, criterion-by-criterion coverage matrix and developer gap report. Validate with doctor; do not execute target tests yet.
```

For a completed or failed run:

```text
$gauntlet-failure-analysis Analyze <run directory> using <config path>. Explain the failures, distinguish API defects from test and fixture problems, and write the developer handoff with reproduction steps and regression checks.
```

The first skill writes `api-analysis.md` and `requirements-matrix.json`; the second writes `developer-analysis.md`. Reports stay in the chosen local artifact directory. A developer can then request a specific repair using the report. Neither invocation automatically changes the application or launches mutating requests.

These skills run using the model selected in Codex. Gauntlet's model is configured separately in `agents` or through its environment overrides. Installing a skill does not create a background process or start a paid Gauntlet discovery run.

See [bring your own API](../training/walkthroughs/03-bring-your-own-api.md) for the complete configuration and execution walkthrough.
