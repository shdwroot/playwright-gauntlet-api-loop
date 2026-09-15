# Walkthrough 5: Damn Vulnerable RESTaurant with real agents

This exercise moves from the deterministic teaching fixtures to a running upstream application. Use the [RESTaurant example guide](../../examples/restaurant/README.md) as the setup/runbook: it contains the exact deployment commands, alternate-port handling, model setup, source-repair opt-in, stop/resume commands and cleanup boundaries.

## 1. Establish the target

Follow setup and doctor in the example guide. Record the selected port, pinned upstream commit and generated config path. Confirm that the contract URL describes the same loopback API you intend to test. Do not substitute a previously repaired lab for a fresh upstream acceptance claim.

Expected evidence: healthy Compose services, accessible `/healthcheck` and `/openapi.json`, and doctor output with a nonzero operation count. This establishes deployment and contract loading, not API correctness or working LLM credentials.

## 2. Read the acceptance criteria

Open [requirements.json](../../examples/restaurant/context/requirements.json) and [scenario-guidance.md](../../examples/restaurant/context/scenario-guidance.md). There are eleven starter criteria across eight requirements. Separate functional expectations from desired secure behavior. The original vulnerable app may fail the secure track; record that failure rather than rewriting it as acceptable.

Use the `gauntlet-api-analysis` [IDE helper](../../docs/ide-helpers.md) to map each criterion to operations, authentication, fixtures, assertions and possible gaps. The complete contract remains available to model discovery for additional scenarios.

## 3. Observe the agent loop

```bash
npm run restaurant:run
```

Read progress for discovery, lead decisions, builder proposals, execution, semantic verification and healing. Inspect actual `agents/calls/` records; a fast deterministic compilation step alone is not proof of an LLM call. Report failed calls or exhausted credits as provider blockers. Both OpenAI and Azure are supported through the configured runtime provider.

Expected evidence: actual model responses when configured successfully, compiled tests, Playwright attempts, criterion links and verified/outstanding counts. Do not expect a fixed test count or automatic success.

## 4. Diagnose one finding

Choose the exact saved run directory printed by the command. Invoke `gauntlet-failure-analysis` through Codex, Claude Code or Copilot. Check the expected behavior's source, actual HTTP exchange, setup evidence, attempt number and owning component.

For protected profile fields, the requirement permits controlled rejection or ignoring the field. A 200 by itself does not prove a defect or a pass: verify the caller and role remain unchanged. Missing credentials, fixtures, observability or schema support are separate gaps.

## 5. Try bounded source repair when desired

The guide's `--workflow source-repair --source auto` command allows edits to the disposable app and configures its optional fixture adapter. Review the repair proposal, syntax/restart evidence and unchanged regression attempt. Pass `--workflow tests-only` to disable source editing even when repair configuration is retained. Application vulnerabilities and unsupported criteria may remain unresolved after the budget expires.

## 6. Maintain and clean up

Start `restaurant:run -- --watch`, then add or revise a criterion in the example context. Confirm a new revision, fresh execution and a revised report. You can also edit a [runtime prompt](../../prompts/README.md) without rebuilding; prompt changes invalidate plan reuse. Do not mistake reused implementation for reused passing evidence.

Stop watch mode before stopping the lab. Use `restaurant:down` to preserve the database and repairs, or the guide's explicit volume-removal command only when you intend to erase disposable data. Keep useful reports and source diffs before starting a new clean checkout.
