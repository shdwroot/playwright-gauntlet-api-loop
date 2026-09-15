# Self-maintaining API Gauntlet implementation plan

The target is the [user-defined lifecycle](agentic-objectives-audit.md). Normal operation uses real agents; scripted providers belong to regression tests. The complete entry points are `npm run gauntlet -- run` and `npm run gauntlet -- run --watch`.

## Delivered and remaining work

| Area | Delivered | Still to implement |
| --- | --- | --- |
| Lifecycle | Prompt/context revision fingerprints, serialized watch runs, locks, history, unchanged-revision plan reuse | Automatic crash recovery and resumable execution |
| Analysis | Consolidated Markdown/JSON, complete attempt history, repairs and model usage | Optional final analyst role and richer requirement/conflict analysis |
| Semantic coverage | Persistent obligations, independent verifier, fresh assertion evidence, reviewed replacement mappings | Exhaustive discovery assurance is not available; broader coverage dimensions and assertion effectiveness checks |
| Test implementation | Typed requests, body/header assertions, bounded concurrency, per-status schemas, setup/cleanup and source-permitted outcome corrections | XML, capture/order repairs and broader implementation repair |
| Reconciliation | Retain omitted obligations; reconcile duplicates/changed context to freshly verified replacements | Selective regeneration and automated handling of ambiguous requirement removals |
| Inputs | OpenAPI 3.x plus bounded UTF-8 context | Swagger 2, WSDL/XSD/SOAP, structured Gherkin, PDF/DOCX and requirements-only projects |
| Verification | Offline regression, OpenAI/Azure HTTP orchestration, focused real Luna lifecycle checks and local RESTaurant setup | Representative multi-format and stateful API acceptance campaign |

These partial areas must not be described as wholly complete. See [recorded validation](validation.md); historical counts and fixture runs are not current production certification.

## Next input and expectation milestone

1. Define versioned source records with raw/extracted hashes, extraction version and line/section citations.
2. Normalize Swagger 2 and OpenAPI 3 without losing original pointers; handle missing operation IDs explicitly.
3. Parse WSDL/XSD operations, messages, bindings and endpoints; generate SOAP envelopes, SOAPAction/content types, XML extraction and fault assertions.
4. Preserve Gherkin scenarios, outlines and examples; extract PDF/DOCX requirements into the same provenance model as text.
5. Support requirements-led expectation models. Missing endpoint, auth, request shape or expected behavior must become an explicit gap.
6. Separate authoritative expectations from inferred hypotheses. Conflicting sources remain visible; observed defects cannot redefine the oracle.

Each adapter needs extraction/normalization checks **and generated request execution** against a representative fixture. Required examples include a SOAP fault, Swagger 2 conversion, Gherkin outline and requirements-only endpoint.

## Coverage and unattended-operation follow-up

- Track declared responses, input partitions, authorization roles and state transitions separately from operation coverage.
- Measure assertions with mutation or controlled fault injection in fixtures that explicitly support it.
- Add state-graph exploration and isolated test-data provisioning with cleanup evidence.
- Extend the existing bounded HTTP 429 recovery and exhausted-credit detection with provider-spend budgets, selective affected-test regeneration and interruption recovery.
- Preserve visible unresolved gaps; never lower a gate merely to obtain a passing report.

## Acceptance criteria for later milestones

A new business rule with no new endpoint must trigger discovery, implementation, execution and a revised report. Repairable test faults must show a verified repair; real product defects must remain red until a scoped application repair passes an unchanged regression. Restart must retain identities, results and validated work. Each supported input format needs source-to-test provenance, and unsupported or unobservable requirements must remain explicit.
