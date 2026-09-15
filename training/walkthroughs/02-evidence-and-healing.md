# Walkthrough 2: distinguish generated drift from a real API defect

You will observe both sides of the safety boundary: a generated-data fault the healer may repair, and an API response defect the healer must leave red.

These exercises use deterministic fixtures. In the [live loop](../../docs/agentic-loop.md), real agents additionally repair request/setup faults, append assertions and add workflows; the same contract boundaries apply.

## What you need

- The repository dependencies installed
- The first walkthrough completed, or `npm run course:example` passing
- Two terminal windows for Part 2

## Part 1: Watch an allowed heal

Run the bundled fault-injection demo:

```bash
npm run demo
```

The demo deliberately changes a generated `createUser` request so its required `name` is empty. The manifest is updated to sign that stale candidate, which means integrity checking alone cannot decide whether the data is correct.

The first attempt fails against the immutable OpenAPI contract. The healer compares the candidate with the trusted deterministic plan, restores only generated files, and runs the full suite again.

Expected outcome:

```json
{
  "status": "PASSED",
  "iterations": 2,
  "heals": [
    {
      "classification": "generated-candidate-drift",
      "policyDecision": "auto",
      "changedFiles": ["plan.generated.json", "manifest.json"]
    }
  ]
}
```

Open the printed `runDir`, then compare:

- `attempts/1/execution.json`: failed execution summary
- `attempts/1/critic.json`: blocking contract finding
- `attempts/1/heal.json`: policy decision and before/after hashes
- `heal-1.diff`: first changed line in each restored generated file
- `attempts/2/critic.json`: clean verdict
- `result.json`: final two-iteration history

The healer did not change an expected status, remove an assertion, add a skip, or edit the API.

## Part 2: Watch a real defect fail closed

The training API has an opt-in defect mode. It returns `{ "state": "ok" }` from `/health`, while the contract requires `{ "status": "ok" }` and forbids undeclared fields.

In terminal A:

```bash
export TRAINING_API_KEY=training-local-key
export TRAINING_API_DEFECT=health-schema
node training/example-project/inventory-api.mjs
```

In terminal B:

```bash
export TRAINING_API_KEY=training-local-key
npm run gauntlet -- run --config training/example-project/gauntlet.config.json
```

Expected terminal result:

```json
{
  "status": "FAILED",
  "iterations": 1,
  "score": 60,
  "hardFindings": ["CONTRACT_ASSERTION_FAILED"]
}
```

An exit code of `1` is expected. The health case fails, while independent tests continue: the current renderer uses default test mode with one worker, not a serial fail-and-skip suite. Main steps within a failed workflow stop, but agent-authored cleanup is still attempted. Unexpected skips would be an additional hard-gate failure.

Copy the `runId` and print the complete result:

```bash
npm run gauntlet -- report <run-id> --config training/example-project/gauntlet.config.json
```

In `result.json`, the heal audit should show:

```json
{
  "classification": "product-contract-or-infrastructure-failure",
  "policyDecision": "denied",
  "changedFiles": []
}
```

Stop terminal A with `Ctrl-C` when finished.

## Part 3: Follow the evidence chain

When a run is red, diagnose it in this order:

1. `result.json`: terminal status and blocking finding codes.
2. `events.json`: the exact state and iteration where the run ended.
3. `attempts/<n>/execution.json`: product, infrastructure, or framework classification.
4. `attempts/<n>/critic.json`: hard-gate decision and evidence pointers.
5. `attempts/<n>/stdout.log`: failing case name and assertion.
6. `attempts/<n>/playwright-report.json` or `html/index.html`: test-level detail.
7. `attempts/<n>/test-results/`: redacted exchange attachments and retained traces for failures.
8. `attempts/<n>/heal.json`: why a repair was allowed or denied.

This order prevents two common mistakes: treating an unreachable API as a schema bug, or weakening a correct assertion because the current API response disagrees.

## Decision table

| Evidence | Meaning | Correct response |
|---|---|---|
| Generated hashes differ from the trusted candidate | Generated drift | Regenerate within the bounded healer policy. |
| Signed candidate matches the contract but an assertion fails | Product or contract disagreement | Review the API and contract; do not auto-heal. |
| `TARGET_UNREACHABLE` | Infrastructure failure | Restore connectivity; keep expectations unchanged. |
| `SKIPPED_TESTS` | The full candidate plan did not execute | Resolve the first failure and rerun; never treat the partial run as a pass. |
| Zero tests or collection error | Framework failure | Fix collection/runtime setup; never call it a passing API. |
| Same candidate and failure fingerprint repeats | Stalled loop | Stop and investigate instead of spending more iterations. |

## What you learned

This offline exercise proves restoration of generated files to the trusted candidate. Live agents can also repair generated request/setup implementations and narrowly defined malformed array comparisons using execution evidence. A source-permitted outcome correction can fix an overrestricted agent-created oracle while preserving the request, assertion values and original response schemas. With configured source access, a developer role can repair the API itself and rerun unchanged tests; see [source repair](../../docs/autonomous-onboarding.md#api-source-repair). Neither mode may rewrite an authoritative expectation to match a product defect.

Next: [Walkthrough 3: bring your own API](03-bring-your-own-api.md).

## Troubleshooting

### The defect exercise passes

Confirm `TRAINING_API_DEFECT=health-schema` is exported in terminal A before the API process starts. Environment changes in terminal B cannot alter an already running server.

### The demo reports `FAULT_INJECTION_UNAVAILABLE`

`--inject-stale-data` currently targets the bundled sample contract's `createUser` positive case. Use `npm run demo` for this exercise rather than applying the flag to the inventory example.

### The trace contains credentials

Request/response attachments pass through recursive redaction, and configured credential-like keys are replaced. If you add custom sensitive fields with unusual names, inspect evidence before sharing it and improve redaction rather than committing the artifact directory.
