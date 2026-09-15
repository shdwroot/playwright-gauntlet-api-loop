# Bounded context validation

Offline sizing on 2026-09-15 reused the saved RESTaurant run `20260915120412-23123-823401`: 116 executed units, 100 passed, 16 failed, 189 retained obligations. Its original verifier call exceeded the old input limit. This check rebuilt inputs from saved plan, discovery, backlog and execution artifacts. It made no paid calls, executed no new API tests and issued no semantic approvals.

| Role | Previous complete call characters | New calls measured | Largest new call | New total characters |
| --- | ---: | ---: | ---: | ---: |
| Builder | 1,289,762 | 1 | 144,044 | 144,044 |
| Lead | 321,178 | 1 | 23,129 | 23,129 |
| Discovery | 363,547 | 5 | 58,228 | 212,488 |
| Verifier | 1,186,278 | 17 | 94,790 | 867,507 |

Complete-context sizing includes serialized input, role/transport instructions and the structured response schema. These are character counts, not token counts or dollar savings. The builder comparison is one focused work assignment, not the cost of completing its whole backlog. Verification sizes include nine semantic batches covering all 67 obligations with linked passing tests, and eight additional isolation batches. All 116 independent units receive isolation assignments. The remaining obligations stay explicit gaps. No fake acceptance result was written to the live run.

Reconciliation calls depend on actual freshly verified replacements and are excluded from this no-approval measurement. Healer/developer calls, later builds, retries and model-output costs are also not included. Real semantic quality and total billed cost still require a subsequent live run. The prior 100/16 execution result remains unchanged.

Regression coverage checks bounded batches with large exchanges, exact criterion/unit assignment, out-of-batch approval rejection, preservation of completed batches, budget exhaustion, indivisible oversized proofs, line-preserving discovery, shared schemas and provenance enums, retained requirement oracles, and HTTP budget enforcement. Existing integration tests continue to run Playwright through build/execute/heal paths using a local scripted provider transport; those tests are not live-model acceptance evidence.
