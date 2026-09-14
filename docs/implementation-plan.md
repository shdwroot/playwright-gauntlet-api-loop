# Self-maintaining API Gauntlet implementation plan

The delivery target is the lifecycle in `agentic-objectives-audit.md`, using real Luna calls in normal operation. Scripted providers are regression-test fixtures only. `npm run gauntlet -- run` remains the complete one-shot entry point; `run --watch` will keep processing context revisions.

## Delivery sequence

1. **Durable lifecycle and reporting** — context fingerprints, serialized execution, revision history, scenario/test/evidence ledger, consolidated Markdown/JSON reports, context-change monitoring, reuse of validated plans when context is unchanged. Detect changes during execution and invalidate acceptance. Preserve all attempt findings in reports.
2. **Input adapters** — common context/provenance representation; OpenAPI 3 and Swagger 2; Gherkin and requirements text; PDF/DOCX extraction; WSDL/XSD with SOAP transport. Document-only projects must report missing target/operation/oracle information explicitly. Never imply that adding a file extension implements a parser.
3. **Semantic acceptance** — requirement extraction and conflict handling; stable scenario identities; explicit implemented, blocked, excluded and retired states; evidence-backed semantic gates alongside immutable contract gates. Operation coverage is never presented as complete scenario coverage.
4. **Implementation and repair** — header/XML assertions, workflow dependencies and cleanup, capture repairs, targeted evidence inspection, implementation-versus-oracle separation, rollback, and preservation of reproducible product defects.
5. **Cross-revision reconciliation** — agents review changed context and previous scenarios/repairs, regenerate affected tests, preserve unaffected work, and execute regression before publishing a new report. Add provider budget/recovery controls and interruption/resume behavior.
6. **Acceptance campaign** — real Luna runs against representative REST and SOAP fixtures; changed requirements without a new endpoint; repairable faults; genuine defects; unresolved scenario gates; restart and concurrent-trigger tests. Keep live evidence separate from scripted orchestration tests.

## Completion criteria

Every supported format has an extraction/normalization test and an execution example. Every relevant requirement links to scenario disposition and test evidence. A context change triggers the whole lifecycle without manual rediscovery. Repairs survive restarts, and a changed requirement cannot inherit a stale pass. Reports explain coverage limits, defects, repairs, blockers, context changes and model usage. No unsupported format or unresolved scenario is silently described as fully covered.

## Next milestone: input and expectation model

- Introduce source records containing format, raw hash, extracted-text hash, extraction version, and line/section citations. Binary-document citations refer to extracted content and retain a link to the original file.
- Normalize OpenAPI 3 and Swagger 2 without losing original source pointers. Generate stable operation IDs when a supported input omits them; report conversion limits explicitly.
- Parse WSDL/XSD into operations, messages, bindings and endpoints. Implement SOAP envelope generation, SOAPAction/content-type handling, XML response extraction and fault assertions, with a local SOAP fixture. A WSDL file extension alone is not support.
- Preserve Gherkin scenarios, outlines and example tables as structured source context. Extract PDF/DOCX requirements into the same provenance model as Markdown/text.
- Allow requirements-led projects to construct a cited operation/expectation model through AI analysis. Missing target, credentials, request shape or expected behavior becomes an explicit blocker; it must not be filled with invented certainty.
- Separate authoritative contract/requirement facts from inferred test hypotheses. Conflicting sources remain visible and block affected completeness claims until resolved. Changing test implementation must not rewrite an authoritative expectation to match an observed defect.

The acceptance fixture for each adapter must execute generated Playwright requests, not merely demonstrate successful parsing. SOAP faults, a Swagger 2 conversion, a Gherkin outline with examples, and a requirement-only endpoint are required cases.

## Implementation tracking

- [x] Durable lifecycle and reporting (first implementation; crash recovery remains in milestone 5)
- [ ] Input adapters
- [ ] Semantic acceptance
- [ ] Implementation and repair
- [ ] Cross-revision reconciliation
- [ ] Live acceptance campaign

These are delivery milestones, not claims of current support. Each milestone must record its checks and remaining limitations before being marked complete.

## First implementation evidence

The one-shot command now persists context revisions, scenario/test links and successful plans, and emits consolidated Markdown/JSON reports. `run --watch` detects configured changes and reruns serially. Changes during execution invalidate acceptance. Identical context/config/framework revisions may reuse successful test implementations; changed revisions start fresh. Reports retain every attempt's findings. A new deterministic gate blocks confident AI scenarios without implementations.

Regression coverage includes revision changes/new files, concurrent writer exclusion, stale-result invalidation, restart persistence, watch coalescing/error behavior, historical failure reporting, and unimplemented semantic scenarios despite passing execution. The existing scripted-provider integration executes real Playwright and checks repair/report evidence; it does not establish live-model reasoning quality.

Remaining limits: content-derived identities do not reconcile paraphrased requirements; document adapters and WSDL/SOAP are not implemented; only current typed repair capabilities exist; source changes rebuild instead of selectively reconciling; crash locks require verified manual recovery. The report is an evidence synthesis, not yet a dedicated final analyst agent. Later milestones remain open.

Live testing exposed two additional issues addressed in this milestone: the healer needed successful state-changing exchanges as well as failures, and the builder needed operation-checked links from existing tests to newly discovered scenarios to avoid duplicating requests under coverage pressure. The broader sample run repaired a reset-header test and reached 33 passing tests, but correctly remained blocked on scenario coverage. Its evidence is `.gauntlet/live-agentic-1789386128179/runs/20260914114208-90105-69e0ad/analysis.md`; it predates the new coverage-link support and is not a final passing acceptance result.

Final milestone verification: **47 regression tests passed**, TypeScript checks passed, and the focused real `gpt-5.6-luna` maintenance check completed **three passing runs**: initial generation, reuse of the validated plan with fresh execution, and a watch-triggered run after a requirement changed. Evidence: `.gauntlet/maintenance-live-1789387249580/acceptance.json`. The script asserts context revision changes and plan-reuse eligibility. This is a small health API acceptance check; multi-format support, broad semantic completeness and the full acceptance campaign remain open.

Additional live-driven improvements include complete-response captures (`$`), workflow-level scenario links, explicit confidence thresholds in agent inputs, stopping repeated rejected proposals, and routing passing execution with coverage gaps back to the builder. Earlier unsuccessful live attempts are retained as evidence; they were not replaced with scripted providers.
