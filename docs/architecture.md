# Architecture

Live Gauntlet is a lead-managed testing loop with deterministic execution and acceptance boundaries. The baseline planner is deterministic; AI-authored additions and repairs can differ between runs. Offline mode uses the baseline and deterministic artifact repair without model calls.

```text
spec + configured context → discovery → persistent obligations
                                  ↓
                            lead / builder
                                  ↓
                       validated plan → renderer
                                  ↓
                   Playwright API execution + cleanup
                                  ↓
                       semantic/isolation verifier
                                  ↓
                     contract/evidence critic
                                  ↓
              accept/report | build gaps | heal failures | block
                                  ↓
              persist revision, backlog, history and eligible plan
                                  ↓
                         watch next context change
```

## Components and roles

| Component | Responsibility |
| --- | --- |
| `src/onboarding.ts`, `src/source-project.ts` | Import a URL and original context; identify supported local source/fixture adapters |
| `src/requirements.ts`, `src/requirement-oracles.ts` | Census structured criteria and retain separate supplemental-oracle provenance |
| `src/source-repair.ts`, `src/local-source-restart.ts` | Scope exact API edits, preserve backups, verify/deploy, and record rollback/image evidence |
| `src/fixtures.ts`, `src/dvra-fixture.ts` | Provision per-test actors and records, supply symbolic bindings, and perform scoped cleanup |
| `src/discovery.ts` | Read bounded local text, redact context, extract deterministic signals and call semantic discovery |
| `src/agents.ts` | Actual Responses API calls for discovery, lead, builder, verifier, critic and healer; role-specific models and structured output |
| `src/agent-loop.ts` | Enforce lead actions, execution/request budgets, repetition stopping and gated acceptance |
| `src/planner.ts` | Compile deterministic baseline cases from the normalized contract |
| `src/agent-plan.ts` | Validate model-authored requests, links, assertions, setup, workflows and cleanup; preserve existing expectations |
| `src/generator.ts` | Render the accepted plan into Playwright tests and hash its generated files |
| `src/generated-runtime.ts`, `src/runner.ts` | Execute real HTTP with Playwright, capture exchanges, assert responses and run cleanup/reset hooks |
| `src/coverage.ts` | Retain obligations, restrict verifier proofs to passing linked tests, validate executable assertion pointers, reconcile to verified replacements |
| `src/critic.ts` | Contract, execution, integrity, coverage and traceability gates; additional model critique cannot waive failures |
| `src/healer.ts` | Restore generated artifacts from the trusted accepted plan when their contents drift |
| `src/maintenance.ts` | Locks, context fingerprints, watch scheduling, history and revision-bound candidate-plan persistence |
| `src/analysis-report.ts` | Consolidate every attempt, coverage, repairs, findings and model usage into Markdown/JSON |

Runtime prompt text is loaded by `src/prompts.ts` from the editable `prompts/` directory. Prompt hashes are part of live context revisions, while executable schemas and validation stay in code.

The executor, compiler, renderer and report writer are code components, not extra LLM agents. Separate prompts and invocation identities establish role separation; using the same model across these roles does not make review mathematically independent.

## Trust boundaries

OpenAPI supplies operation identity, expected statuses and schemas. Supporting text and observed responses are untrusted data: they can motivate tests but cannot grant target authorization, rewrite an existing failed status or instruct the framework to reveal credentials. Explicit structured requirements can supply supplemental routes/statuses with separate provenance and the same host/method policy. Scenario-specific assertions retain contract-context pointers and must distinguish inference from explicit requirements.

Redaction is applied before model inputs and persisted discovery excerpts. Exchange attachments redact credential-like fields. Redaction is pattern-based, not a guarantee that every custom sensitive field is removed; inspect artifacts before sharing them. Model invocation evidence can include bounded redacted document text, while discovery reports retain source hashes, lines and excerpts.

Target host/method restrictions, non-loopback opt-in and destructive-operation policy apply independently of model decisions. Configured credential values are loaded by the worker from environment variables. Models author a typed plan and cannot execute arbitrary JavaScript or shell commands. When source repair is configured, a developer role proposes exact implementation edits; code validates their scope and configured commands verify/restart the API. Tests retain their expectations across the subsequent rerun.

A verifier may block semantic or isolation gaps. Its proof choices are schema-constrained to linked passing tests and executable assertions, then checked again by code. Generic new critic concerns remain warnings unless corroborated by an existing blocking code. Neither role can override execution or contract gates.

## State and persistence

A revision combines spec/source/config content, effective configuration and compiled framework module hashes. A compiled candidate from a completed run is reusable as builder input only for the same revision, and even then discovery and execution run again. A failed candidate is never treated as a passing result. Changed revisions regenerate tests; semantic obligations persist and can be explicitly reconciled to freshly verified replacements. Unresolved removals stay visible.

Locks serialize writers to a generated directory. Watch mode coalesces changes and schedules a new run after the active one completes; mid-run context drift invalidates acceptance. It does not schedule periodic target-only checks, automatically retry unchanged failures, reload existing `.env` values, or recover stale locks after crashes.

Persistent state is under `<artifactsDir>/.maintenance/<generated-directory-hash>/`. Run-specific evidence remains under `<artifactsDir>/<run-id>/`. See the canonical [evidence layout](../training/reference.md#evidence-layout).

Manifest hashes detect generated-file drift; they are not cryptographic signatures from an external signing authority. Reports preserve earlier failures even after a successful repair. A high score cannot excuse zero tests, skipped tests, unverified obligations or changed context.

## Execution isolation

Standalone tests continue after another standalone failure; main steps within a workflow stop at the first failure. Agent-authored cleanup still runs afterward, attempting later cleanup steps even if one fails. Available response captures are collected before assertions so a successfully created resource can be cleaned up after an assertion fails. Missing captures or cleanup failures remain errors.

Configured reset hooks run before and after each independent unit and consume the request budget. Serial execution alone is not isolation. See the [configuration guide](configuration.md#optional-test-environment-reset) for the sample-specific reset and its limits.
