# Validation scope and recorded evidence

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
| Witness live commands | Target-specific preflight or hand-written production journey | See the separately gated [production walkthrough](../training/walkthroughs/05-the-witness-live-production.md) |

Clear model/target environment overrides before offline exercises. Live-model results and test counts can vary; inspect each new report and do not assume an earlier pass persists. Healthy fixture checks do not certify all API formats, complete scenario discovery, arbitrary product repairs, or production lookup/email delivery. A model verification result is evidence-backed review, not formal proof of completeness.

## Documentation verification — 2026-09-14

The documentation review checked local Markdown links/anchors and JSON examples against the checkout, rebuilt the CLI, and ran TypeScript checks. Offline planning confirmed the inventory's 12 standalone cases plus one workflow, the context fixture's 20 standalone cases plus one workflow, and the Witness baseline's 19 covered operations out of 21.

The inventory exercises were executed against disposable loopback servers: the normal run passed all 13 tests with score 100; the deliberately broken health schema produced 12 passes, one failure, zero skips and score 60. These checks correct the old serial-skip guidance. No paid-model or production journeys were rerun for the documentation review.
