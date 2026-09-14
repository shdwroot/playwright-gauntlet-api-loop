# The Witness OpenAPI Gauntlet

This example uses a **source-derived OpenAPI snapshot** of routes and validation contracts from The Witness. It is not an upstream-owned contract or a statement that current production has not changed. The snapshot contains 21 operations; the deterministic baseline covers 19, excluding OAuth callback/handoff transactions that need real one-time provider state.

## Local live-agent example

The target is the loopback `witness-api.mjs` fixture. It makes no production users, provider lookups, email deliveries or OAuth transactions. The framework does make external model calls using the example's live Luna configuration.

From the repository root, build first and supply the key privately in the current shell:

```bash
npm ci
npm run build
# Export OPENAI_API_KEY privately; do not paste it into a command saved in history.
npm run witness:demo
```

The wrapper checks `OPENAI_API_KEY` before loading config, so a key only in `.env` is insufficient for this particular command. It defaults `WITNESS_AUTHORIZATION` to a synthetic fixture token. Clear exported `GAUNTLET_BASE_URL`, `GAUNTLET_AGENT_PROVIDER` and `GAUNTLET_AGENT_MODEL` overrides before using this profile; leave them unset in its adjacent `.env` as well.

The script starts/stops the local fixture and requests controlled generated-data fault injection. In the live loop, pre-execution integrity repair can restore that artifact before HTTP execution. Do not expect exactly two attempts or a fixed test count: live discovery, authoring, semantic/isolation gates and budgets determine the result. A blocked report remains evidence, not a passing demonstration.

## What AI controls

Six roles manage discovery, delegation, implementation, verification, critique and healing. The builder authors concrete requests, assertions and workflows; the deterministic compiler validates and renders the proposal. The verifier reviews passing linked assertions and isolation. The healer can repair test inputs/setup while preserving authoritative expectations. This is no longer a risk-note-only model integration.

The loop cannot edit application source, rewrite expected statuses/schemas, remove existing assertions, or weaken policy to make a defect disappear. See [the agentic guide](../../docs/agentic-loop.md) for supported proposals and limits.

## Evidence

Read the printed `runDir` under `examples/the-witness/.gauntlet/runs/`:

- `analysis.md` and `analysis.json`: consolidated attempts, findings and repairs.
- `coverage-backlog.json`: reviewed and unresolved semantic obligations.
- `agents/calls/`: actual role inputs, outputs and errors.
- `plans/`, `plan.json`, `attempts/<n>/verification.json` and `critic.json`: implementation and review evidence.
- `attempts/<n>/execution.json`: actual target requests and test outcomes.
- `attempts/<n>/integrity-repair.json` or `heal.json`, and `repairs/`: repair evidence when applicable.

These ignored artifacts may not exist until you run the example. For a repeatable offline drift-repair exercise, use `npm run demo`. For focused real-model lifecycle validation, use `npm run maintenance:verify`.

## Production is a separate layer

[Walkthrough 5](../../training/walkthroughs/05-the-witness-live-production.md) documents the GET-only agentic preflight and two explicitly gated **hand-written** Playwright journeys. They do not run as part of `witness:demo`. A local fixture pass or agentic health check cannot certify production authentication, lookup providers, worker analysis or direct email delivery.
