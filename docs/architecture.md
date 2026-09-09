# Architecture

The framework is an explicit evaluator/optimizer state machine:

```text
DISCOVER → PLAN → GENERATE → EXECUTE → CRITIQUE
                                     ↙        ↘
                              PASS/PUBLISH     HEAL → EXECUTE
                                                  ↘ DENY/BLOCK
```

## Roles

- **Lead** (`src/gauntlet.ts`) owns state transitions, budgets, repetition detection, and terminal status.
- **Builder** (`src/agents.ts`) starts from a deterministic OpenAPI compiler. An optional model can add typed risk notes, but cannot write executable code or verdicts.
- **Renderer** (`src/generator.ts`) is the only component that writes generated tests. The same contract, seed, and renderer produce the same bytes.
- **Executor** (`src/runner.ts`) runs the signed candidate with Playwright Test and `APIRequestContext`.
- **Critic** (`src/critic.ts`) receives the immutable contract identity, anonymous candidate manifest, and raw execution summary. Hard gates override any model opinion or score.
- **Healer** (`src/healer.ts`) may restore generated files from the trusted plan. It cannot edit the OpenAPI contract, configuration, custom tests, or system under test.

Builder and critic calls have separate role prompts and invocation identities. With `agents.provider: "openai"`, they can use different models. The deterministic provider keeps CI offline and repeatable.

## Trust boundaries

The OpenAPI contract is the test oracle. Runtime responses are observations, never a source for expected statuses or schemas. Descriptions and response bodies are treated as untrusted data and are never executed as agent instructions.

Credentials are named in configuration but loaded from environment variables inside the Playwright worker. Request and response attachments recursively redact credential-like fields and token-like values.

Non-loopback targets are denied unless `safety.allowProduction` is explicitly enabled and the host is allowlisted. Mutating methods require both a method allowlist entry and `allowDestructive: true`.

## Generated artifacts

`.gauntlet/generated/manifest.json` signs the OpenAPI hash, plan hash, renderer version, seed, and generated file hashes. Each run stores:

```text
.gauntlet/runs/<run-id>/
  run-manifest.json
  events.json
  plan.json
  agents/builder.json
  attempts/<n>/
    execution.json
    playwright-report.json
    junit.xml
    html/
    stdout.log
    stderr.log
    critic.json
    heal.json
    test-results/       # traces and sanitized exchange attachments
  heal-<n>.diff
  result.json
```

Terminal states are `PASSED`, `FAILED`, `BLOCKED`, or `STALLED`. A high score cannot override a hard finding, zero executed tests, skips, missing evidence, or artifact drift.

## Learn this architecture by running it

- [Crash course](../training/README.md): the contract-to-evidence mental model
- [First manual run](../training/walkthroughs/01-first-run.md): each state transition and artifact in practice
- [Evidence and healing walkthrough](../training/walkthroughs/02-evidence-and-healing.md): why generated drift can heal while a real API defect remains red
- [Framework reference](../training/reference.md): exact generation, score, status, and artifact rules
