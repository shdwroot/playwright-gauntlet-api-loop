---
name: gauntlet-api-analysis
description: Analyze a new API contract and requirements for Gauntlet onboarding, criterion coverage, fixture dependencies and developer gaps.
---

Read and follow the shared [gauntlet-api-analysis workflow](../../../.agents/skills/gauntlet-api-analysis/SKILL.md) before starting. It is the maintained source for this helper's analysis procedure, output artifacts and evidence rules. Resolve it from this skill file or locate the Gauntlet repository root; report a missing workflow rather than guessing its contents.

Apply that workflow to the user's supplied API, requirement paths, config or run directory. Produce api-analysis.md and requirements-matrix.json in the selected local artifact directory. End with the next runnable command and its effects. Use the current assistant's model and tools; do not start a Gauntlet model call or target execution merely because this skill was invoked.
