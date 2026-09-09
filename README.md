# Playwright API Gauntlet Loop

An executable TypeScript framework that turns an OpenAPI contract into data and Playwright API tests, runs them, critiques real evidence, and safely repairs generated drift until every hard gate passes or the run fails closed.

This is not a retry wrapper and it does not learn expectations from observed responses. Playwright's `APIRequestContext` is the execution authority; the OpenAPI contract remains the oracle.

## What works

- OpenAPI 3.0/3.1 YAML or JSON ingestion with local `$ref` resolution and duplicate-operation detection.
- Stable positive, validation, boundary, authorization, not-found, conflict, and multi-step workflow cases.
- Deterministic data and generated test bytes from a fixed seed.
- Separate lead, builder, executor, critic, and healer roles.
- Offline deterministic agents by default; optional separate OpenAI builder and critic calls.
- JSON, JUnit, HTML, trace, request/response, event-ledger, manifest, critic, and healing evidence.
- Secret redaction, host/method/request budgets, destructive-operation policy, iteration limits, and repetition stopping.
- Self-healing restricted to generated artifacts. Real API failures are reported and left red.

## Quick start

Requirements: Node.js 20 or newer.

```bash
npm ci
npm run gauntlet -- doctor
npm run demo
```

`npm run demo` starts the loopback sample API, injects stale generated request data, proves the critic rejects it, restores only the generated plan, reruns all regression tests, and exits only after a clean critic verdict.

## Training course

New to the framework? Start with the [20-minute crash course](training/README.md), then work through the three runnable walkthroughs:

1. [Run the inventory gauntlet by hand](training/walkthroughs/01-first-run.md)
2. [Distinguish generated drift from a real API defect](training/walkthroughs/02-evidence-and-healing.md)
3. [Test your own API](training/walkthroughs/03-bring-your-own-api.md)

The course includes a separate five-operation [inventory API](training/example-project/inventory-api.mjs), its [OpenAPI contract](training/example-project/openapi.yaml), a safe loopback [configuration](training/example-project/gauntlet.config.json), and an automated regression test. Run the complete example with:

```bash
npm run course:example
```

Keep the [framework reference](training/reference.md) open while adapting the example.

For the normal sample run without fault injection:

```bash
npm run fixture
```

In another terminal:

```bash
export SAMPLE_API_KEY=gauntlet-local-key
npm run gauntlet -- run
```

The final console output points to `.gauntlet/runs/<run-id>`. Open `attempts/<n>/html/index.html` for the Playwright report or use:

```bash
npm run gauntlet -- report <run-id>
```

## Bring your own API

1. Put an OpenAPI 3.x file in the repository.
2. Copy and edit `gauntlet.config.json`.
3. Keep secrets in environment variables and map only their names in `headersFromEnv`.
4. Allowlist the exact host and methods. Leave production and destructive access disabled unless deliberately required.
5. Run `npm run gauntlet -- generate`, review the signed plan, then run `npm run gauntlet -- run`.

The CLI returns `0` only for a hard-gate pass, `1` for a test/framework failure, `2` for blocked or stalled, and `3` for configuration/runtime errors.

## Safe healing policy

Automatic healing can restore deterministic data, plans, manifests, and rendered tests from the active contract. It records before/after hashes and a diff, then executes the full suite again.

It will not:

- replace expected statuses or schemas with observed responses;
- remove assertions, add skips, hide errors, or increase retries/timeouts;
- edit the API contract, application, configuration, or human-authored tests;
- broaden hosts, methods, credentials, or destructive access;
- classify a target outage as a test fix.

When the signed candidate already matches the contract, a failing API remains a failing API and the repair is denied.

## Development

```bash
npm run build
npm run typecheck
npm run test:unit
npm run test:integration
npm test
```

The required test path is offline except for loopback HTTP. `APIRequestContext` does not require installing a browser binary.

See the [training course](training/README.md), [framework reference](training/reference.md), [architecture](docs/architecture.md), [configuration](docs/configuration.md), and [attribution](NOTICE.md).

Design references: [Playwright API testing](https://playwright.dev/docs/api-testing), [Anthropic's evaluator-optimizer and orchestrator-worker patterns](https://www.anthropic.com/engineering/building-effective-agents), and [RoboNuggets' Gauntlet Loop skill](https://github.com/robonuggets/gauntlet-loop).
