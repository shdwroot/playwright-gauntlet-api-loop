# Autonomous agent loop

The default project configuration uses `gpt-5.6-luna` for discovery, lead, builder, critic, and healer. The CLI loads `.env` beside the selected configuration file; already exported environment variables take precedence. Node 20.12 or newer is required.

Put `OPENAI_API_KEY` in that untracked `.env`, then run:

```bash
npm run gauntlet -- discover
npm run gauntlet -- generate
npm run gauntlet -- run
```

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

For another API, use `--config path/to/gauntlet.config.json`. The config may set `agents.discoveryModel`, `leadModel`, `builderModel`, `criticModel`, and `healerModel` separately; missing discovery/lead/healer models inherit `builderModel`. `agents.provider` must be `openai` to use live agents. `--agentic --model` overrides provider and all role models for that invocation.

## What the agents actually control

| Agent | Work and executable effect |
| --- | --- |
| Discovery | Reads complete bounded, redacted source text and the full contract, identifies semantic edge cases and business scenarios, and returns rationale plus verifiable source citations. It also analyzes the contract when no local sources are enabled. |
| Lead | Selects `build`, `execute`, `heal`, `accept`, or `block` using the current plan, discoveries, evidence, critic findings, and remaining budgets. Supplies the delegated task and can request further coverage after a passing execution. |
| Builder | Authors concrete requests and ordered workflows with response captures and variable substitution. Validated proposals become executable Playwright tests, rather than advisory notes. Receives rejection feedback and critic findings on subsequent builds. |
| Critic | Inspects the implemented plan and real execution evidence. Deterministic integrity, coverage, execution and response-contract gates remain authoritative; unsupported model concerns remain visible warnings. |
| Healer | Diagnoses failed cases using actual error messages and redacted HTTP exchanges. Changes generated request inputs or inserts preparation steps before an existing test, while preserving existing tests and response assertions, then submits the revised implementation for another full run. Genuine product defects remain failures. |

Tests use a declarative implementation format: operation, expected declared status, path/query/header/body inputs, scenario-specific response assertions, and workflow steps with captures. A deterministic renderer translates the agent-authored implementation into Playwright tests. Models do not execute arbitrary JavaScript or shell commands. Currently repairs can change generated request inputs (including baseline requests), add workflows, and insert setup steps immediately before an existing case; they cannot remove baseline cases, change expected responses or assertions, reorder existing workflows, change capture definitions, modify the API application, or fix framework source code during a run. Unsupported repairs and business assertions without a usable contract remain reported gaps.

Example builder proposal:

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
  "riskNotes": []
}
```

The response schema and expected content type come from the selected OpenAPI response. Existing expectations cannot be changed by a repair. Request maps and bodies replace those fields; omitted request fields retain their current values. Credentials are supplied through `headersFromEnv`, never model-generated headers. All tests can reference `${runId}`. Workflow values can also reference a named variable captured by an earlier step. Step IDs are scoped to their workflow; captures use explicit names. Scenario assertions support equality, inequality, length, containment and numeric bounds, cite the associated operation or nested contract pointer, and cannot be changed during repair. A citation identifies the contract context; inferred behavior must still be explained as inference in the rationale.

## Bounds and failure behavior

`maxIterations` limits full executions. Lead decisions are separately bounded to `4 * maxIterations + 2`. In agentic runs `safety.maxRequestsPerRun` is cumulative across reruns, conservatively reserving the entire planned request count before each execution. `agents.timeoutMs` bounds each model call (default 120 seconds).

`discovery.maxAgentInputCharacters` defaults to 200,000 characters of source text. Oversized input fails before a model call; it is never silently truncated. The provider also bounds serialized input and output sizes. Narrow configured sources when the budget is exceeded. `discovery.maxCandidates` and `maxCandidatesPerOperation` bound proposals and generated agent cases.

Invalid proposals are rejected and fed back for correction. Invalid citations, provider errors, missing credentials, or prohibited lead actions produce explicit errors or a recorded blocked run. There is no silent deterministic fallback. Repeated unchanged failures or exhausted decision budgets stop as `STALLED`. A lead cannot accept a run before the critic's hard gates pass.

## Evidence

Run evidence is written to `.gauntlet/runs/<run-id>/`:

- `agents/calls/`: redacted inputs, outputs and errors for every role invocation, including rejected proposals.
- `agents/lead-*.json`, `builder-*.json`, `healer-*.json`: accepted role decisions and model/prompt/response hashes.
- `discovery/report.json`: semantic proposals, rationale, citations, source hashes and model invocation.
- `plans/turn-*.json` and `plan.json`: authored plan revisions and current plan.
- `attempts/<n>/execution.json`, `critic.json`, and Playwright reports: real execution results, failure messages and exchanges.
- `repairs/turn-*.json`: before/after implementation and diagnosis; `heal.json` records the repair decision.
- `events.json` and `result.json`: ordered lifecycle and terminal status.

For a clean discovery JSON artifact, suppress npm's lifecycle headers:

```bash
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

Live OpenAI calls use strict structured output schemas, then decode and validate typed proposals. Invocation records include elapsed time and reported input/output token counts. Source text, arbitrary request bodies, and model decisions are never evaluated as JavaScript.
