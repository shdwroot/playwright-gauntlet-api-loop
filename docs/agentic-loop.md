# Autonomous agent loop

The default project configuration uses `gpt-5.6-luna` for discovery, lead, builder, verifier, critic, and healer. The CLI loads `.env` beside the selected configuration file; already exported environment variables take precedence. Node 20.12 or newer is required.

Set `GAUNTLET_BASE_URL` in that `.env` to override the configured API target, for example `GAUNTLET_BASE_URL=https://api.example.com`. When unset or blank, the selected config's `baseUrl` is used. The target must still satisfy `safety.allowedHosts` and `safety.allowProduction` in the config. See [the environment template](../.env.example) and [configuration precedence](configuration.md#endpoint-and-environment).

Put `OPENAI_API_KEY` in that untracked `.env`, then run:

```bash
npm run gauntlet -- discover
npm run gauntlet -- generate
npm run gauntlet -- run
```

To run the full lifecycle now and keep rerunning when configured context changes:

```bash
npm run gauntlet -- run --watch
```

Watch mode monitors the configured spec, configuration file, discovery files/directories, and framework module fingerprint. Directory sources include newly added files. It coalesces successive changes and serializes runs; a change during execution causes a fresh run afterward. Ctrl+C stops monitoring after the active run finishes. A failed revision is not repeatedly retried without a context change; use a one-shot run to retry unchanged context after repairing an external service.

Each run writes `analysis.md`, `analysis.json`, `context.json`, `scenario-ledger.json`, and `coverage-backlog.json` in its evidence directory. The CLI prints the Markdown report path. The report combines every execution attempt, earlier failures, repair diagnoses, final findings, scenario links, context changes and reported model usage. It distinguishes execution score from scenario completeness.

Maintenance history lives under the artifacts directory's `.maintenance/` folder. A completed run can retain its compiled candidate plan, including when execution failed, to seed a later builder invocation only when context, configuration and framework hashes match. Discovery, generation, execution, verification and critique still run again. Changed context starts a fresh test implementation while retaining previous obligations for explicit semantic reconciliation. The verifier can map duplicates or changed obligations to freshly verified replacements; ambiguous removals stay unresolved. Persisted plans have integrity checks. Failed candidates remain explicitly unvalidated; checkpoint reuse never carries a previous pass.

Concurrent runs or generation into the same generated directory are rejected by `.maintenance.lock`. Normal completion and exceptions release it. After a hard process crash, verify no run is active before removing the stale lock. Automatic crash recovery is not yet implemented.

In live mode, `quality.minimumScenarioCoverage` defaults to `1`: all non-rejected AI scenarios at or above `discovery.minimumConfidence` must link to executable tests. Missing implementations produce `SCENARIO_COVERAGE_GAP`, even if every existing test passes. The threshold is configurable from 0 to 1; deterministic fixtures default to 0. This gate verifies implementation links, not semantic correctness or exhaustiveness of discovery.

The builder receives a bounded worklist of unlinked obligations, prioritizing explicit requirements. Large backlogs receive up to three accepted builder batches before a full execution, so each requirement batch does not consume a separate regression iteration. It must link existing tests or author the missing assertions/workflows. A link remains unverified until fresh execution and independent assertion review succeed.

Agents can use `coverageLinks: [{caseId, discoveryIds, rationale}]` to link an already implemented case to a newly discovered scenario. Links validate operation compatibility and confidence, preserve requests and assertions, and require another execution and critique. Repeating an existing link does not count as progress.

The link target may also be a workflow ID, in which case its main and declared cleanup steps carry the scenario link. Cleanup assertions are eligible proof only after the whole workflow, including cleanup, passes. IDs declared in the proposal may be referenced with or without the generated `agent-` prefix. Workflows support `capture: {wholeBody: "$"}` for comparing complete responses, alongside captures such as `$.id`. Green execution with unresolved coverage returns to the builder; healing is reserved for unsuccessful execution.

For a focused real-model maintenance acceptance check, run `npm run maintenance:verify`. It starts a disposable health API fixture, runs Luna, verifies reuse with fresh execution, changes a requirement, and verifies that watch mode starts the next complete run and report. This checks the maintenance lifecycle on a small contract; it is not a claim of broad API-format coverage.

Discovery analyzes the configured text and OpenAPI without making requests to the target API. It does contact the configured model provider. Generation implements tests without executing them. A run performs discovery and generation, then executes and refines tests. The target API must be running for `run`.

For the included sample, start `npm run fixture` in another terminal. Its `SAMPLE_API_KEY` must match `.env`; you can start it with `node --env-file=.env fixtures/sample-api.mjs`. The sample target is loopback-only. All generated requests remain subject to the selected configuration's host, method, destructive-action, and request limits.

To verify live models against a disposable local fixture (automatically started and stopped):

```bash
npm run agentic:verify
```

This writes isolated configuration, generated tests and run evidence under `.gauntlet/live-agentic-<timestamp>/` and makes paid model calls using the selected configuration.

To select another model temporarily:

```bash
npm run gauntlet -- run --agentic --model YOUR_MODEL_ID
```

For another API, use `--config path/to/gauntlet.config.json`. The config may set `agents.discoveryModel`, `leadModel`, `builderModel`, `verifierModel`, `criticModel`, and `healerModel` separately; missing discovery/lead/healer models inherit `builderModel`, and `verifierModel` inherits `criticModel`. `agents.provider` may be `openai` or `azure` to use live agents. `--agentic --model` overrides all role models and preserves Azure when selected. Azure role models are deployment names; see [Azure configuration](configuration.md#azure-openai).

## Editable system prompts

The seven role prompts and shared plan/transport instructions live in [prompts/](../prompts/README.md). They load on each invocation without a build or restart. Live context revisions include their hashes, so prompt changes invalidate candidate reuse and trigger watch-mode reruns; mid-run changes block acceptance of that result. IDE-helper skill files remain separate.

## What the agents actually control

| Agent | Work and executable effect |
| --- | --- |
| Discovery | Reads complete bounded, redacted source text and the full contract, identifies semantic edge cases and business scenarios, and returns rationale plus verifiable source citations. It also analyzes the contract when no local sources are enabled. |
| Lead | Selects `build`, `execute`, `heal`, `accept`, or `block` using the current plan, discoveries, evidence, critic findings, and remaining budgets. Supplies the delegated task and can request further coverage after a passing execution. |
| Builder | Authors concrete requests and ordered workflows with response captures and variable substitution. Validated proposals become executable Playwright tests, rather than advisory notes. Receives rejection feedback and critic findings on subsequent builds. |
| Verifier | Independently reviews scenario assertions and test isolation. Structured proof choices are limited to linked tests that passed and their executable assertion pointers. Missing, invalid or incomplete proofs block semantic acceptance; reviewed replacements preserve reconciliation evidence. |
| Critic | Inspects the implemented plan and real execution evidence. Deterministic integrity, coverage, execution and response-contract gates remain authoritative; unsupported model concerns remain visible warnings. |
| Healer | Diagnoses failed cases using actual error messages and redacted HTTP exchanges. Changes generated request inputs or inserts preparation steps before an existing test, while preserving existing tests and response assertions, then submits the revised implementation for another full run. Product defects delegate to source repair when configured and otherwise remain failures. |
| Developer | Proposes scoped API source edits after an evidenced product defect. Configured commands validate/restart the service before the unchanged tests execute again. |

Healer inputs now also include bounded observations from successful tests, with timestamps where Playwright supplies them. This lets the agent investigate preceding deletes, creates and resets instead of assuming the API still has its initial fixture state. Truncated evidence is marked; the full Playwright report remains available in the run directory. Classification is still model reasoning, not a guaranteed diagnosis.

Assertion/capture paths support JSON Pointer for dictionary keys, such as `/paths/~1register/post`, alongside `$.field` paths. Header names normalize to a case-insensitive field path, so `Server` cannot produce a false absence pass when `server` is present. Paths are read as data and never evaluated as code.

Tests use a declarative implementation format: operation, expected declared status, path/query/header/body inputs, scenario-specific response assertions, and workflow steps with captures. A deterministic renderer translates the agent-authored implementation into Playwright tests. Models do not execute arbitrary JavaScript or shell commands. Currently repairs can change generated request inputs (including baseline requests), add workflows with cleanup, append assertions, and insert setup steps immediately before an existing case; they cannot remove baseline cases, weaken expected responses or valid assertions, reorder existing workflows, change capture definitions, or fix framework source code during a run. The narrow `assertionRepairs` operation corrects malformed root-array numeric comparisons while retaining the original bound. A separately configured developer role can patch API source, validate and restart it, then rerun the unchanged plan; see [source repair](autonomous-onboarding.md#api-source-repair). Unsupported repairs and business assertions without a usable contract remain reported gaps.

When a linked, recorded scenario explicitly permits alternatives, `outcomePolicyId` compiles each permitted declared response with its own schema and content type. Supported phrases cover explicit status alternatives and controlled rejection versus ignoring or returning a schema-valid response. Ambiguous prose is rejected. The compiler never infers permission from the status observed during execution. `outcomeRepairs` can correct an overrestricted agent-created oracle using an already-linked policy; baseline oracles remain fixed, including baselines whose requests were repaired by an agent. Requests, assertion values and original contract schemas are preserved.

Assertions citing a particular numeric response branch run only for that branch. Shared state invariants must remain unconditional or be checked in a following request. Semantic proof catalogs include conditional assertions and variant schemas only when their branch was observed in a passing execution. An allowed 200 does not establish that protected state remained unchanged.

A temporary provider HTTP 429 receives at most two retries, honoring `Retry-After` within the original call deadline. Recognized credit/quota exhaustion stops immediately with `AGENT_PROVIDER_QUOTA_EXHAUSTED`; restore credits before resuming. Other HTTP failures and ambiguous transport failures are not blindly retried. No failed live call falls back to deterministic agents.

Example decoded builder proposal (not the raw model transport; typed request envelopes and capture bindings are decoded before compilation; API payloads travel in bodyJson; assertion values are native JSON):

```json
{
  "cases": [{
    "id": "last-page",
    "title": "Smallest valid page beyond the collection",
    "operationId": "listUsers",
    "status": 200,
    "rationale": "An offset beyond existing records should still return a valid page.",
    "request": {"query": {"limit": 1, "offset": 10000}}
  }],
  "workflows": [],
  "repairs": [],
  "assertionAdditions": [],
  "coverageLinks": [],
  "riskNotes": []
}
```

Use `json-equals` with a JSON-encoded object/array value for exact structured comparisons. Compilation parses it into immutable deep equality; ordinary `equals` does not parse strings. Invalid root-body absence checks and length comparisons on numeric fixture counts are rejected before execution.

The response schema and expected content type come from the selected OpenAPI response. Existing expectations cannot be changed by a repair. Request maps and bodies replace those fields; omitted request fields retain their current values. Valid credentials are supplied through `headersFromEnv`. Missing/invalid-auth tests can omit auth or use compiler-controlled synthetic invalid credentials for declared 4xx responses. All tests can reference `${runId}`. Workflow values can also reference a named variable captured by an earlier step. Step IDs are scoped to their workflow; captures use explicit names. Scenario assertions support equality, inequality, length, containment and numeric bounds, cite the associated operation or nested contract pointer, and cannot be changed during repair. A citation identifies the contract context; inferred behavior must still be explained as inference in the rationale.

## Concurrent workflow steps

Give 2–8 consecutive main steps the same `parallelGroup` to issue their requests concurrently. Captures, peer dependencies and fixture observations are forbidden inside a group; perform setup before it and final database checks afterwards. Each step declares its primary `status` and any `alternativeStatuses`; every status must exist in the contract, and its own response schema/content type remains enforced. Existing status sets cannot be changed by healing.

The first step must carry a `target: "parallel"` assertion on `$.successCount` (2xx responses) or `$.requestCount`. For a single-use coupon, assert exactly one success; two successes remain a failure even if each individual response is valid. All requests settle before aggregate assertions and cleanup. Every request consumes the normal budget. This supports a bounded overlapping request test, not load testing or a guarantee of every possible server interleaving.

## Semantic obligations

`quality.requireSemanticVerification` and `quality.requireIsolationReview` default to true for live runs. They add gates beyond `minimumScenarioCoverage`, which checks links only. The verifier reviews eligible AI obligations at the configured confidence threshold; low-confidence proposals remain visible without implying that they have been verified.

`coverage-backlog.json` persists after unsuccessful as well as successful runs. Current emitted states are `unimplemented`, `verified`, `gap`, `needs-review` and `superseded`. Implementation links are tracked separately in `scenario-ledger.json`. Rediscovery retains omitted obligations and cannot silently lower their confidence or reject them. A superseded obligation records its replacement IDs and review reason. Verification is refreshed every run.

Each obligation with a linked passing test gets exactly one keyed review. Obligations without a linked passing test remain deterministic gaps, with their full criteria retained for reconciliation; the model does not need to emit repeated empty-proof assessments. Proof choices are limited to that obligation's linked, passing tests and the assertions the runtime actually checks. The framework validates them again; schema descriptions and invented pointers are not evidence. This is bounded model review of observable behavior, not formal proof or a claim that discovery found every requirement.

## Cleanup and isolation

Agent workflows accept `cleanupSteps` alongside main `steps`. Cleanup uses the same declared operation/status/request format, can reference earlier captures, and runs after failed assertions as well as success. Later cleanup steps are attempted even if an earlier one fails. Unavailable captures and cleanup failures are reported; they do not erase the original failure.

`assertionAdditions: [{caseId, assertions}]` appends validated assertions to existing tests. It cannot remove or replace expectations. `repairs[].setupSteps` establishes prerequisites before an existing case. Existing capture definitions and main-step order are still immutable.

For disposable targets with a declared reset endpoint, [configure reset hooks](configuration.md#optional-test-environment-reset). The bundled sample enables them; arbitrary target APIs do not automatically gain a reset operation. All cleanup/reset traffic consumes the cumulative live request budget. Process termination, timeouts or target unavailability can prevent successful cleanup.

## Bounds and failure behavior

`maxIterations` limits full executions. Lead decisions are separately bounded to `6 * maxIterations + 2`. In agentic runs `safety.maxRequestsPerRun` is cumulative across reruns, conservatively reserving the entire planned request count before each execution, including cleanup and reset hooks. `agents.timeoutMs` bounds each model call (default 120 seconds).

`discovery.maxAgentInputCharacters` defaults to 200,000 characters of source text. Oversized input fails before a model call; it is never silently truncated. The provider also bounds serialized input and output sizes. Builder and lead feedback omit oversized duplicated evidence payloads with explicit omission counts while retaining diagnostic text and the original on-disk artifacts. An input-limit error names the role and measured size. Narrow configured sources when the budget is exceeded. `discovery.maxCandidates` and `maxCandidatesPerOperation` bound proposals and generated agent cases.

Invalid independent builder units are rejected and fed back for correction while valid cases, whole workflows, and validated links are retained. Each workflow remains atomic: an invalid step prevents that entire workflow from being accepted. Rejections are recorded in `agents/builder-<turn>-validation.json` and stay in the coverage backlog; retaining valid work does not waive any acceptance gate. Healer proposals remain atomic. Invalid citations, provider errors, missing credentials, or prohibited lead actions produce explicit errors or a recorded blocked run. There is no silent deterministic fallback. Repeated unchanged failures or exhausted decision budgets stop as `STALLED`. A lead cannot accept a run before the critic's hard gates pass.

Three repetitions of the same builder/healer validation error without an accepted proposal stop as `STALLED`, avoiding repeated paid calls that make no progress. Agents receive the configured discovery confidence threshold and explicit eligibility errors.

## Evidence

Run evidence is written to `.gauntlet/runs/<run-id>/`:

- `agents/calls/`: redacted inputs, outputs and errors for every role invocation, including rejected proposals. Input records include the assembled `effectiveInstructions`, role `system` and `transportInstructions`.
- `agents/lead-*.json`, `builder-*.json`, `healer-*.json`: accepted role decisions and model/prompt/response hashes.
- `discovery/report.json`: semantic proposals, rationale, citations, source hashes and model invocation.
- `plans/turn-*.json` and `plan.json`: authored plan revisions and current plan.
- `attempts/<n>/verification.json`: semantic/isolation review, proof references and findings.
- `attempts/<n>/execution.json`, `critic.json`, and Playwright reports: real execution results, failure messages and exchanges.
- `repairs/turn-*.json`: before/after implementation and diagnosis; `heal.json` records the repair decision.
- `events.json` and `result.json`: ordered lifecycle and terminal status.
- `analysis.md`, `analysis.json`, `context.json`, `scenario-ledger.json`, `coverage-backlog.json`: consolidated report, revision metadata, implementation links and reviewed obligations.

For a clean discovery JSON artifact, suppress npm's lifecycle headers:

```bash
mkdir -p .gauntlet
npm run --silent gauntlet -- discover > .gauntlet/discovery.json
```

The CLI prints provider mode to stderr, leaving the JSON result on stdout.

## Explicit offline mode

The reproducible fixture configuration is `gauntlet.offline.config.json`:

```bash
npm run gauntlet -- discover --config gauntlet.offline.config.json
npm run demo
npm test
```

These use deterministic extraction and baseline generation. The CLI labels offline mode and its discovery report states that no model analysis occurred. Automated agent-loop tests use a scripted HTTP model server with real Playwright execution; they verify orchestration and repair mechanics without claiming to measure a live model's reasoning.

Preparation repairs use `repairs[].setupSteps`: the framework inserts those validated steps immediately before the original case. A standalone case moves intact into a workflow, retaining its ID, request, expected response, and assertions. Independent test cases continue after a failure; workflows still execute their own steps in order. An audit-only risk note does not count as an executable repair.

Live OpenAI and Azure calls use strict structured output schemas, then decode and validate typed proposals. Invocation records include elapsed time and reported input/output token counts. Source text, arbitrary request bodies, and model decisions are never evaluated as JavaScript.
