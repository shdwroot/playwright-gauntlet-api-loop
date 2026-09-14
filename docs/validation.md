# Validation scope and recorded evidence

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
