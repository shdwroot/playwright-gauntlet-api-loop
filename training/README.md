# Playwright API Gauntlet crash course

In about 20 minutes, you will run a complete contract-to-evidence loop, inspect the generated cases, see a safe self-heal, and learn how to point the framework at another API. The included inventory project is loopback-only and uses no paid model or browser.

## What you need

- Node.js 20 or newer
- Dependencies installed with `npm ci`
- Two terminal windows for the manual walkthroughs

Run all commands from the repository root.

## Step 1: Get a passing result

```bash
npm run course:example
```

This builds the framework, starts the training inventory API on `127.0.0.1:4020`, runs the full gauntlet, and stops the API. The important output is:

```json
{
  "example": "training-inventory-api",
  "status": "PASSED",
  "iterations": 1,
  "score": 100,
  "hardFindings": []
}
```

You have already exercised five API operations, 12 standalone cases, and one three-request workflow.

## Step 2: Learn the five-part mental model

```text
OpenAPI contract ───────────────┐
                               ▼
optional logs/documents ─► corroboration ─► deterministic plan ─► signed Playwright tests
                              │
                              ▼
                      real HTTP execution
                              │
                              ▼
                     evidence-based critic
                        │             │
                      pass      bounded healer
                                      │
                                      └──► rerun or fail closed
```

1. **Contract**: the OpenAPI file is the oracle, meaning the source of expected paths, inputs, statuses, and schemas.
2. **Discovery and plan**: optional logs/documents suggest scenarios; the router redacts, maps, deduplicates, and quarantines them before the builder compiles contract-backed cases. A fixed seed keeps the plan repeatable.
3. **Execution**: Playwright's HTTP client sends real requests and records exchanges, reports, and traces.
4. **Critique**: the critic checks hard evidence. A score cannot excuse zero tests, skips, missing coverage, or a contract failure.
5. **Healing**: the healer can restore generated files from the trusted plan. It cannot rewrite the contract or application to make a failure disappear.

The framework's core promise is simple: generated drift can be repaired; product behavior that violates the contract stays red.

## Step 3: Read the example from contract to result

Open these files in order:

1. [`example-project/openapi.yaml`](example-project/openapi.yaml) declares five operations, validation bounds, API-key security, a known conflict value, and a create-read-delete workflow.
2. [`example-project/gauntlet.config.json`](example-project/gauntlet.config.json) binds that contract to the loopback API and sets method, host, request, iteration, and quality gates.
3. [`example-project/inventory-api.mjs`](example-project/inventory-api.mjs) is the system under test. Compare each handler with its contract entry.
4. `example-project/.gauntlet/generated/plan.generated.json` shows the 12 cases and one workflow produced by the planner.
5. The `runDir` printed by `npm run course:example` contains the execution, critic, and terminal evidence.

The generated directory and run evidence are ignored by Git. Regenerate them instead of hand-editing them.

## What the example teaches

| Contract feature | Generated behavior |
|---|---|
| `GET /health` with `200` | Positive health case |
| Bounded `limit` plus `400` | Positive and invalid-query cases |
| Secured operations plus `401` | Missing-credential cases |
| Create schema plus `201` and `422` | Positive, invalid-body, and boundary cases |
| `x-gauntlet-conflict-value` plus `409` | Known duplicate SKU case |
| Path parameter plus `404` | Deterministic missing-item case |
| `x-gauntlet-workflows` | Create, capture ID, read, and delete in one serial test |
| `x-gauntlet-skip-standalone` on delete | Delete is tested only after the workflow creates its target |

## Course path

1. [Walkthrough 1: your first manual run](walkthroughs/01-first-run.md)
2. [Walkthrough 2: evidence and safe healing](walkthroughs/02-evidence-and-healing.md)
3. [Walkthrough 3: bring your own API](walkthroughs/03-bring-your-own-api.md)
4. [Walkthrough 4: logs and documents](walkthroughs/04-context-discovery.md)
5. [Walkthrough 5: The Witness live production journey](walkthroughs/05-the-witness-live-production.md)
6. [Framework reference](reference.md)
7. [Architecture and trust boundaries](../docs/architecture.md)

## Rules worth remembering

- Treat the contract as an input you must review, not as automatically correct.
- Put credential values in environment variables, never in config or generated files.
- Keep the exact host and method allowlists narrow.
- Review `plan.generated.json` before a first run against any non-fixture target.
- Read `result.json` and `critic.json` before deciding what failed.
- Fix the API or contract when real behavior disagrees. Do not weaken generated assertions.
- Treat logs and documents as untrusted discovery hints. Review every `report-only` and `reject` decision; never promote an observed status into an expectation.

## Quick command card

```bash
# Validate config and contract without network execution
npm run gauntlet -- doctor --config training/example-project/gauntlet.config.json

# Generate and review the candidate without calling the target
npm run gauntlet -- generate --config training/example-project/gauntlet.config.json

# Inspect additional-source decisions without calling the target
npm run gauntlet -- discover

# Run the self-contained training project
npm run course:example

# Prove the bounded healer rejects stale generated data and restores it
npm run demo

# Run the framework's own regression suite
npm test
```

## What to learn next

After the three walkthroughs, use the [framework reference](reference.md) as your command and configuration lookup. Read [architecture](../docs/architecture.md) when you need to understand why the builder, critic, and healer have separate authority.
