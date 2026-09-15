---
name: gauntlet-failure-analysis
description: Diagnose a Gauntlet run from saved evidence, separating API defects, generated-test problems, missing prerequisites and coverage gaps.
---

Read and follow the shared [gauntlet-failure-analysis workflow](../../../.agents/skills/gauntlet-failure-analysis/SKILL.md) before starting. It is the maintained source for this helper's analysis procedure, output artifacts and evidence rules. Resolve it from this skill file or locate the Gauntlet repository root; report a missing workflow rather than guessing its contents.

Apply that workflow to the user's supplied API, requirement paths, config or run directory. Produce developer-analysis.md alongside the selected run, preserving attempt IDs, evidence paths, reproduction prerequisites and regression checks. Use the current assistant's model and tools; do not start a Gauntlet model call or target execution merely because this skill was invoked.
