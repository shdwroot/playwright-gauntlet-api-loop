# The Witness OpenAPI Gauntlet

This example turns the Fastify routes and Zod contracts in the private
`shdwroot/the-witness` repository into an executable OpenAPI-first test loop.
The repository did not contain an OpenAPI or Swagger document, so
`openapi.yaml` is explicitly labelled source-derived rather than upstream-owned.

## Safety boundary

The default target is the loopback-only `witness-api.mjs` contract fixture.
It creates no production users, sends no email, performs no OSINT lookups, and
never calls an OAuth provider. Production is intentionally excluded from this
default command. The separate live profiles require an exact hostname allowlist
and explicit confirmation for any record creation or external action.

The OpenAPI document covers all 21 observed HTTP routes. Nineteen are covered by
generated cases or workflows. The OAuth callback and handoff exchange remain
documented but excluded from this synthetic run because meaningful execution
requires a real browser/provider transaction and one-time state.

## Run the end-to-end loop

From the repository root:

```bash
npm test
OPENAI_API_KEY="your-key" npm run witness:demo
```

`OPENAI_API_KEY` is read from the process environment only. The demo injects a
controlled stale generated-test-data defect so the first Playwright attempt
fails. The healer may regenerate only these signed files:

- `plan.generated.json`
- `api.generated.spec.mjs`
- `manifest.json`

It then reruns Playwright. It will not edit the OpenAPI contract, the fixture,
application source, or an assertion to hide a product failure.

## What OpenAI does

The OpenAI builder reviews the deterministic OpenAPI-compiled candidate and
returns bounded risk notes. The executable Playwright source remains owned by
the deterministic compiler. After execution, a separate OpenAI critic reviews
the anonymous manifest, coverage, and Playwright evidence. Deterministic hard
gates still decide whether the run can pass.

This division is intentional: the model helps identify risks and critique the
result, while every executable assertion stays traceable to an immutable
OpenAPI pointer and the healer cannot weaken it.

## Inspect the evidence

The final JSON output prints `runDir`. Inside it, inspect:

- `discovery/report.json` for source signals and exact citations.
- `agents/builder.json` for the OpenAI builder invocation hashes and output.
- `attempts/1/execution.json` for the injected failing Playwright attempt.
- `attempts/1/heal.json` and `heal-1.diff` for the bounded repair audit.
- `attempts/2/critic.json` for the passing critic verdict.
- `result.json` for the signed run outcome.

Generated artifacts and run evidence live below `examples/the-witness/.gauntlet/`
and are ignored by Git.

## Walk through production yourself

Use [Walkthrough 5](../../training/walkthroughs/05-the-witness-live-production.md)
for the ordered production checks. It starts with an OpenAI-assisted GET-only
preflight, then offers a safe disposable-record journey and a separately gated
full provider/analysis/email journey. The guide states the expected result and
stop condition at every step; neither live journey runs as part of
`npm run witness:demo`.
