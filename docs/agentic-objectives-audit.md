# Audit against the requested agentic API lifecycle

Date: 2026-09-14. Reviewed checkout: `91497da`.

Verdict: **partially implemented; the complete objective is not met.**

The objective is a maintained testing system: ingest API contracts and supporting context, discover scenarios with AI, implement Playwright API tests, execute them, investigate and repair failures, produce a full analysis, and repeat automatically when context changes. This audit uses the user's stated objectives. Exact parity with Robonuggets' implementation has not been assessed; no specific reference implementation was supplied.

## Objective coverage

| Objective | Current implementation | Assessment |
| --- | --- | --- |
| Accept WSDL, OpenAPI, Swagger, requirements and feature files | Mandatory OpenAPI 3.x contract plus bounded local text sources | Partial; WSDL/SOAP, Swagger 2 and document-only entry are unsupported |
| AI analyzes context and discovers scenarios | Live model receives contract and redacted source text | Present, but discovery happens once per run |
| AI generates API Playwright tests | Model authors typed requests, assertions and workflows; renderer emits executable Playwright | Present within a limited test format |
| Execute and investigate failures | Real Playwright runner; critic and healer receive execution summaries and HTTP exchanges | Present with bounded evidence access |
| Repair and retest autonomously | Request-data changes and inserted setup steps, followed by regression | Partial; broader test implementation repairs unsupported |
| Log failures and changes | Invocation logs, execution evidence, plan revisions and repair diffs | Present |
| Full analysis report | JSON result, critic findings and separate evidence files | Partial; no consolidated requirements/scenario/failure/repair analysis |
| Maintain suite when context changes | New manual run reloads inputs; source hashes detect mid-run drift | Missing automatic triggering, persistent scenario reconciliation and cross-run maintenance |

## Findings

### P1 — Input architecture excludes several requested starting points

`src/openapi.ts:168–175` parses JSON/YAML and explicitly rejects anything other than OpenAPI 3.x. `src/config.ts:115` requires a spec path. Supplemental discovery sources are text reads, not format-specific extraction; default extensions at `src/config.ts:62` exclude `.feature`, `.wsdl`, PDF and DOCX. Adding an extension alone would not implement SOAP contracts, binary-document extraction or structured Gherkin semantics.

Consequence: users cannot start with WSDL or requirements alone, and Swagger 2 documents cannot drive tests. Requirements cannot serve as an independent expectation authority: the critic requires OpenAPI provenance (`src/critic.ts:76–89`).

Required change: source adapters feeding a shared, versioned context model with provenance, explicit conflicts and unknowns. Include OpenAPI 3, Swagger 2 conversion, WSDL/XSD and SOAP execution, Gherkin, Markdown/text, and PDF/DOCX extraction. Useful later inputs include Postman collections, sanitized HTTP traces and changelogs. Missing endpoint/auth details must become explicit blockers rather than invented facts.

### P1 — No maintained lifecycle across context changes

`src/cli.ts:63–80` exposes one-shot execution and result retrieval. `src/agent-loop.ts:15–25` starts a fresh contract, ledger and empty plan. Discovery is called once before the decision loop (`src/agent-loop.ts:43–47`); the lead has no rediscovery action. Source drift is reported by the critic rather than triggering a new context revision (`src/critic.ts:102–114`).

Consequence: adding a requirement does not automatically cause scenario discovery, test reconciliation, execution and a revised report. Repairs are recorded but are not loaded as durable knowledge for the next run.

Required change: persistent source/scenario/test identities, context revision detection, a watch or CI trigger, serialized runs, impact analysis, and reconciliation of added/changed/retired scenarios. Preserve validated repairs and failure history across runs. A change during execution should invalidate the affected evidence and schedule a fresh revision.

### P1 — Passing does not establish scenario completeness

The hard coverage gate counts operations (`src/critic.ts:56–60`). Discovery completeness checks only candidates already marked generate/merge (`src/critic.ts:118–125`); report-only proposals can remain unimplemented. New model concerns are downgraded to warnings (`src/critic.ts:19–35`), and the model's proposed decision is not used directly in final acceptance (`src/critic.ts:178–186`).

Consequence: a suite can pass with a score of 100 while missing business requirements or important discovered edge cases. The current score must not be presented as complete testing assurance.

Required change: a requirement-to-scenario-to-test-to-evidence coverage ledger. Every relevant scenario needs an implemented result, evidenced exclusion, or visible unresolved gap. Preserve deterministic contract gates while allowing independently verified semantic findings to prevent a completeness claim. Do not grant unverified model opinions automatic authority.

### P1 — Healing cannot repair the full range of test implementation failures

`src/agent-plan.ts:5–13` defines a constrained test and repair format. Repairs change request fields or insert setup; they cannot fix captures, existing workflow order, assertion implementation or runtime code. `src/agents.ts:124–132` only applies changes classified as test implementation. The loop terminates on a healer proposal without executable changes (`src/agent-loop.ts:105`).

Consequence: the system can repair some data/setup failures but cannot maintain arbitrary Playwright API tests. Assertions inferred incorrectly by a model can also become unrepairable under the current blanket immutability rule.

Required change: separate authoritative expectations from their test implementation. Permit verified repairs to implementation, dependencies, captures and setup/cleanup while retaining scenario intent and authoritative expectations. Extend the typed format or introduce isolated code authoring with review and rollback. Provide targeted evidence-inspection tools. A real API defect should remain reproducible and reported; fixing application source requires source access and an explicitly defined repair scope.

### P2 — Evidence collection is not yet the requested full analysis report

`src/evidence.ts:62–64` finalizes `result.json`; `src/cli.ts:72–80` prints it. Evidence is spread across separate files. `src/agent-loop.ts:33–38` builds final findings from the current verdict, which is cleared after a plan change, so later blockers can omit earlier critic findings from the final summary even though attempt artifacts remain.

Required change: generate a consolidated report covering context revision, requirement/scenario coverage, executed and untested scenarios, defects, repair attempts and their verification, unresolved blockers, evidence links, changes since the prior run, and model/runtime usage. Build it from the complete event history rather than only the last verdict.

## Acceptance evidence needed

1. Run representative OpenAPI, Swagger 2 and WSDL APIs, plus a requirements/feature-led project; show source-to-test traceability and explicit missing-information handling.
2. Add a new business rule with no new endpoint. The system detects the change, creates the missing scenario, runs its test, and updates the report without a manual rediscovery command.
3. Seed a repairable test/setup fault and show diagnosis, implementation diff, successful rerun and reuse of the repair on the next context revision.
4. Seed a real API defect and prove it remains reported; the agent must not change inputs to stop exercising the failing behavior.
5. Leave a required scenario unsupported and prove the report cannot claim complete coverage merely because all existing tests pass.
6. Restart the process and prove scenario identities, context revisions, prior results and validated repairs survive.

## Recommended implementation order

1. Shared context/provenance model and persistent scenario coverage ledger.
2. Input adapters and explicit requirement-derived expectations.
3. Broader test implementation and evidence-led repair capabilities.
4. Context-change orchestration and durable reconciliation.
5. Consolidated analysis report and end-to-end acceptance checks above.

This was a source-level objective audit. No runtime code was changed and no new model calls or test runs were made. Earlier live-run summary files were not present at the previously recorded paths in this checkout, so this audit does not independently certify those historical results.
