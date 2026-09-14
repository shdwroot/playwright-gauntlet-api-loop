# Architecture

The framework runs a lead-managed discovery, implementation, execution and repair loop in OpenAI mode. The default project models are gpt-5.6-luna. The deterministic provider is an explicit offline fixture mode. See [agentic loop](agentic-loop.md) for the executable proposal format, limits and evidence. Discovery now has two inputs: the authoritative OpenAPI contract and optional untrusted local context.

```text
DISCOVER → PLAN → GENERATE → EXECUTE → CRITIQUE
                                     ↙        ↘
                              PASS/PUBLISH     HEAL → EXECUTE
                                                  ↘ DENY/BLOCK
```

```text
configured logs/documents
  → path + type + byte limits
  → immutable source hashes
  → redaction before persistence/agent access
  → bounded deterministic extraction + LLM analysis of complete source text
  → exact method/path OpenAPI mapping
  → generate | merge | report-only | reject
  → planner (OpenAPI remains the assertion oracle)
```

## Roles

- **Lead agent** (`src/agents.ts`) chooses the next action and delegates concrete tasks using the plan, discoveries and evidence. `src/agent-loop.ts` enforces action validity, execution/request budgets, repetition detection and acceptance gates.
- **Discovery router** (`src/discovery.ts`) enumerates configured local sources, rejects unsafe input, redacts secrets/PII, extracts scenario signals, maps them exactly to OpenAPI operations, and preserves every source disposition.
- **Builder** (`src/agents.ts`) starts with baseline contract coverage and authors concrete requests and stateful workflows. `src/agent-plan.ts` validates these proposals and incorporates them into the executable plan. Rejected proposals and critic findings are fed back to the agent.
- **Renderer** (`src/generator.ts`) is the only component that writes generated tests. The same accepted plan and renderer produce the same bytes; live model-authored plans can differ between runs.
- **Executor** (`src/runner.ts`) runs the signed candidate with Playwright Test and `APIRequestContext`.
- **Critic** (`src/critic.ts`) receives the immutable contract identity, anonymous candidate manifest, and raw execution summary. Hard gates override any model opinion or score.
- **Healer agent** (`src/agents.ts`) diagnoses execution failures and revises generated request implementations or adds workflows. Existing cases and response expectations are preserved. `src/healer.ts` additionally repairs artifact drift from the accepted plan. Neither path edits the API application or contract.

Discovery, lead, builder, critic and healer calls have separate role prompts and invocation identities. With `agents.provider: "openai"`, they can use different models. The deterministic provider keeps CI offline and repeatable.

## Trust boundaries

The OpenAPI contract is the test oracle. Runtime responses, system logs, incident notes, and documents are observations, never a source for expected statuses or schemas. Source text is tainted data and is never executed as an agent instruction. An observed `500` where OpenAPI declares success is retained as a contract-violation finding; it never becomes an expected `500`. An undocumented endpoint is a contract gap, not a generated request.

Discovery reads local sources and, in OpenAI mode, sends bounded redacted text and contract context to the configured model. Offline discovery is deterministic and local-only. Every configured source is parsed or the run fails closed; no remote URLs, archives, binaries, non-UTF-8 text, symlinks, paths outside the config root, or files above configured limits are accepted. Source order does not control candidate order. Deterministic duplicates merge citations. LLM proposals retain their rationale, source citations, and model invocation.

Redaction occurs before excerpts reach plan artifacts or optional model agents. Bearer tokens, credential headers/fields, sensitive query parameters, emails, and customer-like identifiers are replaced with typed placeholders. Generated request values remain synthetic and schema-derived; observed identifiers and payloads are not replayed.

Credentials are named in configuration but loaded from environment variables inside the Playwright worker. Request and response attachments recursively redact credential-like fields and token-like values.

Non-loopback targets are denied unless `safety.allowProduction` is explicitly enabled and the host is allowlisted. Mutating methods require both a method allowlist entry and `allowDestructive: true`.

## Generated artifacts

`.gauntlet/generated/manifest.json` signs the OpenAPI hash, plan hash, renderer version, seed, and generated file hashes. Each run stores:

```text
.gauntlet/runs/<run-id>/
  run-manifest.json
  events.json
  discovery/report.json
  plan.json
  agents/builder.json
  attempts/<n>/
    execution.json
    playwright-report.json
    junit.xml
    html/
    stdout.log
    stderr.log
    critic.json
    heal.json
    test-results/       # traces and sanitized exchange attachments
  heal-<n>.diff
  result.json
```

Terminal states are `PASSED`, `FAILED`, `BLOCKED`, or `STALLED`. A high score cannot override a hard finding, zero executed tests, skips, missing evidence, or artifact drift.

The discovery hash signs source hashes, parser version, redacted evidence, mapping decisions, and dispositions. The critic re-hashes the report, rechecks source bytes before accepting a run, verifies every executable discovery candidate has a citation and exact operation mapping, and requires every assertion to carry OpenAPI oracle provenance. A changed or missing source stops acceptance instead of silently using stale context.

## Learn this architecture by running it

- [Crash course](../training/README.md): the contract-to-evidence mental model
- [First manual run](../training/walkthroughs/01-first-run.md): each state transition and artifact in practice
- [Evidence and healing walkthrough](../training/walkthroughs/02-evidence-and-healing.md): why generated drift can heal while a real API defect remains red
- [Framework reference](../training/reference.md): exact generation, score, status, and artifact rules
- [Context discovery walkthrough](../training/walkthroughs/04-context-discovery.md): add logs/documents and audit every decision
