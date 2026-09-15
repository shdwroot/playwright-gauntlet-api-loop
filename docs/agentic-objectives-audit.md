# Audit against the requested agentic API lifecycle

Updated for the current runtime, provider, prompt and helper interfaces, 2026-09-15. The original [baseline audit](history/2026-09-14-initial-objectives-audit.md) is retained as history; its missing-watch/report findings are no longer current.

**The OpenAPI agentic lifecycle is implemented, with bounded repair and semantic review. The full multi-format objective remains incomplete.** Exact parity with RoboNuggets' implementation has not been assessed.

| Objective | Current implementation | Remaining gap |
| --- | --- | --- |
| Accept WSDL, OpenAPI, Swagger, requirements and feature files | OpenAPI 3.x contract plus local UTF-8 context | WSDL/SOAP, Swagger 2, binary-document extraction, structured Gherkin and requirements-only entry |
| AI analyzes context and discovers scenarios | Real model analyzes bounded source text and contract each run | Structured JSON criteria have an exhaustive census; general-prose discovery remains fallible and there is no within-run rediscovery action |
| AI implements Playwright API tests | Typed requests, body/header assertions, sequential and bounded parallel workflows, captures and cleanup compiled into Playwright | Arbitrary JavaScript, XML, general code/capture repair and specialized observation adapters |
| Execute, investigate, repair and retest | Real HTTP evidence; request/setup repairs, narrow malformed-assertion corrections, and configured API patch/restart/unchanged regression | Valid assertions, captures and step order remain protected; source repair requires a configured checkout and deployment commands |
| Preserve failures and changes | All model calls/errors, plan revisions, execution attempts and repair evidence | No external issue publication; automatic application fixes are bounded by source scope and verification |
| Full analysis report | Consolidated Markdown/JSON with context, links, backlog, attempts, failures, repairs and model usage | Report synthesis is deterministic, not a separate final analyst agent |
| Maintain on context changes | Watcher, prompt/context revision history, locks, candidate-plan continuation and persistent obligations, including failed runs | No automatic crash-lock recovery, scheduled target monitoring or selective test regeneration |
| Verify scenario meaning and isolation | Separate live verifier; schema-constrained assertion references; passing linked tests and executed response branches; isolation review | Model judgments remain fallible; ambiguous removals and missing oracles stay unresolved |

## Resolved baseline findings

- `src/maintenance.ts` provides change-triggered serialized runs, revision snapshots and candidate-plan continuation without carrying a prior pass. Changed context cannot inherit a prior pass.
- `src/analysis-report.ts` consolidates all attempts; earlier failures remain visible after a later successful repair.
- `src/coverage.ts` retains semantic obligations, checks fresh execution and actual assertion references, and records reviewed mappings to verified replacements. Rediscovery cannot silently lower an outstanding obligation's confidence or reject it to bypass coverage.
- `src/agent-plan.ts` and `src/generated-runtime.ts` support appended assertions, failure-path workflow cleanup and configured per-test reset hooks. Cleanup/reset requests count against the live run budget.

## Current developer interfaces

OpenAI-compatible and Azure OpenAI providers share the same agent loop and deterministic gates. Markdown system prompts in [prompts/](../prompts/README.md) are editable without rebuilding; live revision hashes include prompt changes. Codex, Claude Code and Copilot have [shared project helpers](ide-helpers.md). The [Damn Vulnerable RESTaurant example](../examples/restaurant/README.md) supplies a disposable upstream setup and starter criteria, not an exhaustive API certification.

## Remaining priorities

1. A common provenance and expectation model with real adapters for the requested formats.
2. Broader repair of implementation details while preserving authoritative expectations and reproducible product defects.
3. Coverage dimensions beyond operation/link counts: responses, input boundaries, state transitions and assertion effectiveness.
4. Selective regeneration, recovery after interruption and bounded provider-spend controls.
5. A representative REST/SOAP acceptance campaign with documented business-rule oracles.

See the [implementation plan](implementation-plan.md) for delivery criteria and [validation record](validation.md) for what was actually exercised. A healthy fixture and a passing execution score do not establish exhaustive coverage or all external-provider effects.
