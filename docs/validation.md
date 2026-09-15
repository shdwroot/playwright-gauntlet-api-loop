# Validation scope and recorded evidence

## RESTaurant example and documentation refresh — 2026-09-15

- TypeScript and **91 framework tests pass** after removing two retired application-example tests and adding workflow boundary coverage. Local Markdown files, anchors, JSON examples, npm entry points and the new setup script are checked against this checkout.
- A fresh upstream `d32d09972aec7830f5f1d4a5d274cac7aae7eb82` checkout built successfully with the example Dockerfile and Compose overlay on `127.0.0.1:8092`. The existing app on 8091 was left unchanged. A missing C-header dependency discovered during the clean build was corrected in the Dockerfile.
- Both services became healthy; doctor imported **21 operations**, and all **11 starter criteria** mapped to declared operations. Direct Playwright HTTP checks confirmed health/contract/menu 200 responses and profile 401 without credentials.
- Automatic source/fixture detection found the fresh deployment. API-issued tokens authenticated two Customers, an Employee and a Chef with the expected profiles. The pagination fixture contained 101 orders; cleanup removed all six namespace-owned users with no retained referenced menu records. Local evidence: `.gauntlet/restaurant-example/setup-validation.json` (ignored).
- Stop/resume commands were exercised with the dedicated database preserved; the verification lab was stopped afterward. The existing 8091 deployment remained running.
- These are setup, contract and fixture checks, with no paid LLM calls. They do not establish discovery quality, full criterion acceptance or successful source repair on this fresh app. Earlier repaired-app runs below remain historical. See [setup and scope](../examples/restaurant/README.md).

## Editable runtime prompts — 2026-09-15

- TypeScript and **92 automated tests pass**. Prompt checks cover reload without rebuilding, shared includes, literal capture placeholders, missing/empty/oversized files, invalid includes and installation-relative resolution.
- An isolated copy of the compiled runtime proves prompt edits alter the context revision and block a result when edited during execution. HTTP provider tests compare recorded assembled instructions with the actual request and confirm system edits change the prompt hash.
- Existing OpenAI and Azure transport/orchestration regressions pass with file-loaded prompts. These checks do not establish a new live-model acceptance result.

## Azure provider — 2026-09-15

- TypeScript and **89 automated tests pass**. Azure checks cover v1 URL normalization, API-key headers, deployment selection, structured output and usage parsing, missing credentials, HTTP errors, live quality defaults, URL onboarding/refresh and CLI provider preservation.
- A controlled Azure-compatible HTTP endpoint drives the full discovery/build/execute/verify/heal/rerun flow against a disposable API. This tests protocol and orchestration; no actual Azure deployment acceptance run has been performed.
- Azure supports API-key authentication and v1 Responses with JSON-schema structured outputs. Entra ID credential acquisition and legacy preview API versions are not implemented.

## Repair and coverage follow-up — 2026-09-15

- TypeScript checks and **85 automated tests passed**. New checks cover exact JSON comparisons over HTTP, dictionary response paths, declared 4xx credential tests, typed request envelopes, retained-plan execution after rejected follow-up batches, partial acceptance of independent builder units, cleanup evidence links, bounded concurrent requests, per-status response schemas, and cleanup after a failed race assertion.
- The recorded local RESTaurant run `20260914223518-62481-b16e5d` executed 57 tests: initially 56 passed and one failed. Luna repaired `create_order_service.py`, validated/restarted the API, and the unchanged suite then passed **57/57**. This verifies that repair against that suite.
- That run still verified only **13 of 165** retained semantic obligations and later stalled during coverage expansion. The subsequent compiler fixes and static proposal replay address those expansion failures; they are not evidence of complete API coverage. The next broad live run must establish its own result.
- Concurrent-workflow regression uses a controlled HTTP server to prove overlapping requests, one-winner assertions, per-status schema checks and cleanup ordering. It does not certify the target API's coupon-race behavior.

- A separate settings API regression accepts both source-permitted rejection and ignored updates, but rejects changed state (including a misleading response), malformed error schemas and undeclared server-error outcomes. Conditional proof checks reject unexecuted branches and evidence from failed attempts. These are controlled HTTP framework tests, not paid-model acceptance runs.
- Provider transport checks prove bounded temporary-throttle recovery, immediate credit-exhaustion failure, deadline handling and omission of private provider error text.
- The later real Luna run `20260914231241-98904-be7b9f` executed 63 tests: 61 initially passed, then 62 passed after source repair; one generated workflow remained overrestricted. Its requirement permitted rejection **or ignoring** protected fields, but the test demanded rejection. The generic outcome-policy correction above addresses this class of test defect locally. The run verified **26 of 184** retained obligations before the final verifier was blocked by HTTP 429. A diagnostic confirmed `credit_balance_exhausted`. Live verification of the latest framework remains pending restored provider credits; no complete coverage claim is made.

## Coverage/isolation milestone — e777f42, 2026-09-14

- **56 Node tests passed**, along with TypeScript checks and [GitHub CI](https://github.com/shdwroot/playwright-gauntlet-api-loop/actions/runs/34860615197).
- Three real `gpt-5.6-luna` lifecycle runs passed against a disposable local **health API**: initial run, unchanged-revision plan reuse with fresh execution, and watch-triggered execution after a requirement changed.
- The reuse run recovered from a malformed builder assertion value using decoding feedback. Earlier unsuccessful live attempts were retained, and exposed unsupported discovery claims and invalid/duplicate verifier references that were addressed before acceptance.
- Regression checks cover stale/omitted obligations, reviewed replacement mappings, confidence preservation, invalid proof references, append-only assertions, reset request accounting, and cleanup after assertion/cleanup failures over real HTTP.

Recorded local acceptance artifact: `.gauntlet/maintenance-live-1789398444733/acceptance.json`. It is ignored by Git and may be absent in another checkout. The three run IDs are `20260914150724-17023-c0b351`, `20260914150821-17023-ea5766`, and `20260914151017-17023-bf7645`.

## Reproduce the appropriate layer

| Command | What it checks | External activity |
| --- | --- | --- |
| `npm test` | Deterministic regression and scripted-provider orchestration with real Playwright HTTP | Loopback fixture requests; no paid model calls |
| `npm run typecheck` | Framework TypeScript correctness | None |
| `npm run course:example` | Inventory contract-to-execution tutorial | Loopback fixture requests |
| `npm run demo` | Deterministic generated-data drift repair | Loopback fixture requests |
| `npm run maintenance:verify` | Real-model lifecycle, reuse and requirement-change rerun | Paid model calls plus disposable local health API |
| `npm run agentic:verify` | Broader real-model sample exploration | Paid model calls plus disposable local users API |
| `npm run restaurant:setup` / `restaurant:doctor` | Fresh pinned lab deployment, contract import and configuration | GitHub, registry/package downloads, Docker and loopback contract retrieval; no LLM calls |
| `npm run restaurant:run` | Real agents test the live local application | Paid model calls and scoped loopback API mutations |

Clear model/target environment overrides before offline exercises. Live-model results and test counts can vary; inspect each new report and do not assume an earlier pass persists. Healthy fixture checks do not certify all API formats, complete scenario discovery, arbitrary product repairs, or external provider side effects. A model verification result is evidence-backed review, not formal proof of completeness.

## Documentation verification — 2026-09-14

The documentation review checked local Markdown links/anchors and JSON examples against the checkout, rebuilt the CLI, and ran TypeScript checks. Offline planning confirmed the inventory's 12 standalone cases plus one workflow, the context fixture's 20 standalone cases plus one workflow.

The inventory exercises were executed against disposable loopback servers: the normal run passed all 13 tests with score 100; the deliberately broken health schema produced 12 passes, one failure, zero skips and score 60. These checks correct the old serial-skip guidance. No paid-model or production journeys were rerun for the documentation review.

Explicit workflow validation: tests-only overrides persisted source repair and ignores an unused source path; the source editor rejects calls in tests-only mode. Source-repair accepts a matching checkout and rejects a mismatched root or missing repair configuration. Existing patch rollback and accepted-edit checks also pass. These checks use isolated test providers; no additional paid model run was performed.
