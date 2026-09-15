# Framework reference

Use this page when you know what you want to do and need the exact command, setting, generated case rule, status, or evidence path. Start with the [crash course](README.md) if this is your first run.

## Requirements

- Node.js 20.12 or newer
- An OpenAPI 3.x document in JSON or YAML
- A reachable HTTP or HTTPS API
- Environment variables for any configured credentials

Playwright uses `APIRequestContext`, its HTTP client. Browser binaries are not required.

## CLI

Run commands through the package script so the TypeScript source is built first:

```bash
npm run gauntlet -- <command> [options]
```

| Command | Options | Result |
|---|---|---|
| `doctor` | `--config <path>` | Validates configuration and contract loading, then reports the target, contract hash, operation count, and workflow count. It does not call the target API. |
| `discover` | `--config <path>` | Analyzes the contract and configured local context; live mode calls the model, offline mode uses deterministic extraction. It does not call the target API. |
| `generate` | `--config <path>` | Builds a contract baseline, adds live agent proposals when enabled, and writes the generated plan, Playwright test, and hash manifest. |
| `run` | `--config <path>`, `--watch`, `--inject-stale-data` | Generates, executes, critiques, and, when policy permits, heals and reruns the suite. `loop` is an accepted alias for `run`. |
| `report` | `<run-id-or-directory>`, `--config <path>` | Prints the saved `result.json`. A bare run ID is resolved beneath the configured `artifactsDir`. |

`doctor`, `discover`, `generate` and `run` also accept `--url`, repeated `--context`, `--project-dir`, `--model` and `--workflow source-repair --source auto|path`. With `--url`, onboarding fetches the contract from the target before the selected command; discovery/generation still do not execute test operations. See [automatic onboarding](../docs/autonomous-onboarding.md).

The default config path is `gauntlet.config.json` in the current directory; it uses live Luna agents. `discover` is a subcommand, not `--discover`. Append `--agentic --model MODEL_ID` to override all role models and enable live mode. `--agentic` preserves Azure when selected. For OpenAI, `OPENAI_MODEL` is the fallback with `--agentic`; URL onboarding also uses it. For Azure, use deployment names and `AZURE_OPENAI_DEPLOYMENT`.

Watch mode reports each run and continues monitoring. Use one-shot `run` for a CI exit code: stopping the watcher does not summarize prior run failures. `--inject-stale-data` applies to one-shot runs, not watch runs.

### Exit codes

| Code | Meaning |
|---:|---|
| `0` | The command completed; for `run`, every hard gate passed. |
| `1` | The API or framework failed a run. |
| `2` | The run ended BLOCKED or STALLED; inspect findings for provider, oracle, policy, budget, context or repetition details. |
| `3` | An uncaught CLI/configuration/contract/runtime error occurred. Errors recorded inside the live loop may instead return BLOCKED (2). |

## Configuration

Paths and automatic `.env` loading are relative to the selected config directory. Exported values win. Nonblank `GAUNTLET_BASE_URL` overrides `baseUrl`; `GAUNTLET_AGENT_PROVIDER` and `GAUNTLET_AGENT_MODEL` override provider and all role models. Restart watch after environment changes; `.env` is not monitored. See [configuration](../docs/configuration.md).

### Top-level fields

| Field | Required | Default | Rules and effect |
|---|---:|---:|---|
| `projectName` | Yes | None | Non-empty name written into plans and run evidence. |
| `spec` | Yes | None | Local OpenAPI file. It must stay within the config directory. |
| `baseUrl` | Unless overridden | None | HTTP(S) target, overridden by nonblank `GAUNTLET_BASE_URL`. Its hostname must be allowlisted. |
| `generatedDir` | Yes | None | Framework-owned plan, test, and manifest directory. It must stay within the config directory. |
| `artifactsDir` | Yes | None | Run evidence directory. It must stay within the config directory. |
| `seed` | No | `42` | Finite number used for repeatable generated data and stable case IDs. |
| `maxIterations` | No | `3` | Floored to an integer and clamped to at least `1`. |
| `timeoutMs` | No | `30000` | Per-test timeout, clamped to at least `1000` milliseconds. |
| `headersFromEnv` | No | `{}` | Maps lowercase HTTP header names to environment-variable names. Values never belong in config. |
| `discovery` | No | Disabled | Controls supplemental text sources; live discovery still analyzes the contract. |
| `isolation` | No | Omitted | Live-mode reset configuration: `{operationId, request}` for a declared, permitted success operation, run before/after each independent unit. No capture variables. |

### `discovery`

| Field | Required | Default | Rules and effect |
|---|---:|---:|---|
| `enabled` | No | `sources.length > 0` | Enables local context discovery. |
| `required` | No | `false` | With `true`, zero configured or matched sources fails closed. |
| `sources` | No | `[]` | File/directory entries. A string means `kind: auto`; objects accept `id`, `path`, and `kind: auto\|log\|document`. Paths must remain beneath the config root. |
| `allowedExtensions` | No | `.json,.jsonl,.log,.md,.txt,.yaml,.yml` | Exact extension allowlist. Binary data is still rejected. |
| `maxFiles` | No | `100` | Maximum unique regular files after canonical-path deduplication. |
| `maxFileBytes` | No | `5242880` | Per-file byte ceiling checked before parsing. |
| `maxTotalBytes` | No | `26214400` | Aggregate byte ceiling across the corpus. |
| `maxCandidates` | No | `5000` | Pre-deduplication signal ceiling; overflow fails instead of truncating. |
| `maxCandidatesPerOperation` | No | `20` | Executable discovery expansion ceiling for one operation. |
| `maxExcerptCharacters` | No | `512` | Deterministic redacted excerpt length stored with citations. |
| `maxAgentInputCharacters` | No | `200000` | Bounded source text sent for live discovery; overflow fails rather than silently truncating. |
| `minimumConfidence` | No | `0.85` | `0..1` floor for executable consideration; lower-confidence signals remain report-only. |

Each configured source appears in the source manifest. Missing sources, symlinks, path escapes, non-regular files, binary/NUL data, invalid UTF-8, unsupported extensions, mutation during read, and size/count overflow fail closed. Directories are traversed in sorted order with `.git`, `.gauntlet`, and `node_modules` excluded.

Redaction precedes persistence and agent input. Credential headers/fields, bearer tokens, sensitive query values, emails, and customer-style IDs are replaced. Discovery reports retain hashes, locations, lines and redacted excerpts. Model-call input artifacts can include bounded redacted document text. Pattern-based redaction cannot guarantee removal of every custom sensitive field.

#### Discovery dispositions

| Disposition | Meaning | Execution effect |
|---|---|---|
| `generate` | Exact operation/status corroboration and a safe contract-derived input recipe exist. | Adds one case unless semantic deduplication finds an equivalent case. |
| `merge` | Evidence matches an existing planner or discovery case. | Adds citations; does not add a redundant Playwright test. |
| `report-only` | Evidence is incomplete, conflicting, undocumented, operational, oversized, or unsafe to reproduce. | Initially unimplemented; eligible live semantic proposals can be implemented by agents. Confident unresolved AI obligations can block acceptance. |
| `reject` | Ambiguous or policy-denied evidence cannot be trusted. | Preserved with a reason and never executed. |

The offline extractor's executable recipes are deliberately narrow: malformed JSON, unsupported media type, bounded query violations, and whitespace validation, each only when the applicable response is declared. Missing auth, not-found, and conflict signals merge into existing contract cases. Oversized payloads, undocumented endpoints, observed undeclared statuses, and unclassified prose remain report-only.

Deterministic candidate IDs are based on normalized signals; LLM IDs hash title/scenario/operation content, not timestamps, correlation IDs, absolute checkouts, or source order. Duplicate candidates preserve citations in stable path/line order. The planner hashes final dispositions and the critic rechecks the report hash and current source bytes.

### `safety`

The `safety` object is required.

| Field | Required | Default | Rules and effect |
|---|---:|---:|---|
| `allowedHosts` | Yes | None | Array of exact hostnames accepted by `baseUrl`. |
| `allowedMethods` | Yes | None | Non-empty subset of `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, and `OPTIONS`. Other values fail configuration validation. |
| `allowDestructive` | No | `false` | Must be `true` before the planner accepts `POST`, `PUT`, `PATCH`, or `DELETE`. |
| `allowProduction` | No | `false` | Must be `true` for any non-loopback target, in addition to exact host allowlisting. |
| `maxRequestsPerRun` | No | `100` | Live mode reserves cumulative requests across attempts, including cleanup/reset hooks. Offline mode bounds plan size; reruns are not cumulatively metered by that loop. Clamped to at least `1`. |
| `maxResponseBytes` | No | `65536` | Maximum response text retained and checked by the worker. Clamped to at least `1024`. |

Loopback hostnames are `localhost`, `127.0.0.1`, and `::1`.

### `agents`

The `agents` object and both model names are required.

| Field | Required | Default | Rules and effect |
|---|---:|---:|---|
| `provider` | Yes | None | `deterministic` keeps runs offline; `openai` or `azure` uses six live roles plus the optional source-repair developer. |
| `builderModel` | Yes | None | Model authors concrete requests, assertions and workflows; the deterministic compiler validates and renders them. |
| `criticModel` | Yes | None | Model label, OpenAI model or Azure deployment used for critic findings. Hard gates remain authoritative. |
| `discoveryModel`, `leadModel`, `healerModel` | No | `builderModel` | Role-specific model overrides. |
| `verifierModel` | No | `criticModel` | Semantic/isolation reviewer. |
| `timeoutMs` | No | `120000` | Per-model-call timeout in milliseconds. |
| `openaiBaseUrl` | No | `https://api.openai.com` | Base URL used only by the OpenAI provider. |
| `azureEndpoint` | For Azure unless env is set | `AZURE_OPENAI_ENDPOINT` | Azure resource URL or `/openai/v1/` base. |
| `apiKeyEnv` | No | Azure: `AZURE_OPENAI_API_KEY`; otherwise `OPENAI_API_KEY` | Name of the model credential environment variable. |

`GAUNTLET_AGENT_MODEL` takes precedence over `AZURE_OPENAI_DEPLOYMENT`; either overrides all role models. Leave both unset for separate configured Azure deployments. See [Azure setup](../docs/configuration.md#azure-openai).

### `quality`

The `quality` object is required.

| Field | Required | Default | Rules and effect |
|---|---:|---:|---|
| `minimumScore` | No | `95` | Numeric pass floor clamped to `0..100`. It cannot override a hard finding. |
| `minimumOperationCoverage` | No | `1` | Required covered-operation ratio clamped to `0..1`. `1` means 100 percent. |
| `minimumScenarioCoverage` | No | Live: `1`; offline: `0` | Eligible AI scenario-to-test linkage ratio, clamped to `0..1`. |
| `requireSemanticVerification` | No | Live: `true`; offline: `false` | Requires reviewed semantic proofs backed by passing linked tests. |
| `requireIsolationReview` | No | Live: `true`; offline: `false` | Requires isolation review of each standalone test/workflow. |

## Contract support

The loader accepts OpenAPI `3.x` JSON and YAML. It requires at least one operation, a unique non-empty `operationId` for every operation, and at least one numeric response per operation.

- Local `$ref` values beginning with `#/` are resolved. Remote references fail with `CONTRACT_REF_DENIED`.
- Cyclic and unresolved schema references fail closed.
- Path, query, header, and cookie parameters are normalized; path parameters are always required.
- JSON and `+json` request bodies drive generated data. A non-JSON request body produces a warning and no generated body.
- Non-numeric response keys such as `default` are warned about and ignored.
- Root or operation-level `security` marks an operation as secured.

### Gauntlet extensions

| Extension | Location | Effect |
|---|---|---|
| `x-gauntlet-conflict-value` | A request-body schema property | Supplies the known duplicate value used by a generated `409` conflict case. |
| `x-gauntlet-skip-standalone` | An operation | Prevents standalone cases for that operation. A workflow can still cover it. |
| `x-gauntlet-workflows` | OpenAPI root | Defines ordered multi-request tests with response capture and later substitution. |

A workflow can capture `$response.body#/id`. A later path parameter such as `${steps.create.itemId}` is normalized to `${itemId}` and substituted from the captured value at execution time. Direct `body`, `query`, and `pathParams` fields are also accepted by the loader.

## Generated case rules

The baseline planner is deterministic. Live builder additions and repairs can differ between runs; a fixed seed does not make model output deterministic.

| Kind | Generated when | Expected result |
|---|---|---|
| `positive` | An allowed, non-skipped operation declares at least one `2xx` response. | Any declared `2xx` status, plus declared content type and schema. |
| `validation` | A `422` response, or otherwise a `400`, is declared and the request has required or bounded input. | The selected validation status. |
| `boundary` | The operation has an object-like or bounded request body. | Declared success using maximum or minimum boundary values. |
| `authorization` | The operation is secured and declares `401`. | `401` with configured credentials intentionally omitted. |
| `not-found` | The operation has a path parameter and declares `404`. | `404` using a deterministic missing identifier. |
| `conflict` | The operation has a request body and declares `409`. | `409`, normally using `x-gauntlet-conflict-value`. |
| `discovered` | An eligible deterministic source recipe or validated AI-authored case maps to a declared operation and response. | Declared response status/content/schema, including separately traced explicit requirement supplements; observed responses never redefine the oracle. |

Each workflow becomes one Playwright test, with sequential main steps except for explicitly bounded parallel groups. The live request budget counts main steps, cleanup and reset hooks. OpenAPI-extension final delete steps are ordinary main steps, not failure-path cleanup; agent workflows expose explicit `cleanupSteps`.

## Runtime assertions

For every generated case, the worker:

1. Loads configured credentials from environment variables.
2. Substitutes captured workflow values.
3. Sends the request with `failOnStatusCode: false` so the contract controls acceptance.
4. Attaches a redacted request/response exchange.
5. Checks status, declared content type, and the supported JSON Schema subset.
6. Checks typed scenario assertions: equality/inequality, presence/absence, length comparisons, contains and numeric bounds, with the appropriate body/header/fixture/parallel target.
7. For positive object requests, checks matching response fields round-trip unchanged.

The schema checker covers object properties and required fields, `additionalProperties: false`, arrays and item counts, string length/pattern and email format, numeric bounds, enums, constants, nullability, `allOf`, `anyOf`, and `oneOf`.

Body assertion paths accept JSON Pointer as well as supported `$.field` paths. Header assertions use normalized, case-insensitive names. `json-equals` authors exact structured values; the compiler parses the literal before execution. Source-permitted alternative outcomes retain each response schema, and branch-specific assertions can count toward coverage only when that branch ran in a passing test. Bounded parallel groups support 2–8 consecutive main steps, aggregate request/success counts, and cleanup after all requests settle. See [the agentic guide](../docs/agentic-loop.md) for the proposal protocol and limits.

## Critic score and hard gates

The deterministic score totals 100 points:

- 40: execution passed with zero failed tests
- 25: operation coverage ratio
- 15: executed test count matches the signed plan, with no skips
- 10: artifact integrity and contract hash match
- 10: no forbidden test controls or invalid traceability

Every corroborated blocking `AI_` critic finding subtracts 10 points, but score alone never passes a run. Zero tests, count mismatch, skips, target failure, contract assertion failure, artifact mismatch, forbidden `skip`/`only`/`fixme`, invalid traceability, or insufficient coverage remains blocking. Discovery additionally hard-fails on report hash mismatch, source drift or absence, secret leakage, executable candidates without citations/exact operation mapping, and assertions without active OpenAPI oracle provenance.

Semantic and isolation gates add `SEMANTIC_COVERAGE_GAP` and `TEST_ISOLATION_GAP`; linkage uses `SCENARIO_COVERAGE_GAP`. Generic new critic opinions are advisory. A score is not a completeness percentage.

## Terminal statuses

| Status | Meaning |
|---|---|
| `PASSED` | No blocking findings remain and the score meets `minimumScore`. |
| `FAILED` | A product/contract failure is not safely healable, or the iteration budget ended. |
| `BLOCKED` | Target/model/configured-operation blockers, unavailable oracles, request limits, context drift or a lead block prevent acceptance. Read findings for the exact cause. |
| `STALLED` | Repeated failures/proposal errors, no progress, or the bounded lead-decision budget stopped the loop. |

## Evidence layout

```text
<artifactsDir>/<run-id>/
  run-manifest.json
  events.json
  context.json
  discovery/report.json
  plan.json
  scenario-ledger.json
  coverage-backlog.json              # live semantic obligations
  analysis.md / analysis.json
  agents/calls/*-input.json          # live call evidence
  agents/calls/*-output.json         # or *-error.json
  agents/lead-*.json / builder-*.json / healer-*.json
  plans/turn-*.json
  repairs/turn-*.json
  attempts/<iteration>/
    execution.json
    verification.json               # live semantic/isolation review
    critic.json
    heal.json                       # when a heal occurs
    integrity-repair.json           # live artifact repair, when needed
    playwright-report.json
    junit.xml
    html/index.html
    stdout.log / stderr.log
    test-results/
  result.json
```

Not every mode or attempt emits every optional file. Offline generation stores `generated-manifest.json` and `agents/builder.json`; live runs use turn-numbered builder artifacts. Artifact-drift repairs write diffs, while agent implementation repairs retain before/after plans under `repairs/`.

`analysis.md` consolidates history; `result.json` is the terminal summary. `scenario-ledger.json` records implementation links; `coverage-backlog.json` records verification/reconciliation state. Do not treat either a link or an execution score as exhaustive coverage.

Cross-run state lives in `<artifactsDir>/.maintenance/<generated-directory-hash>/`: `latest.json`, `history/`, `validated-plan.json` for successful plans, and a live `coverage-backlog.json`. Locks live at `<generatedDir>/.maintenance.lock`; after a crash, verify the process has stopped before removing a stale lock.

## Editable prompts and IDE helpers

Runtime instructions live in [prompts/](../prompts/README.md); changes load without a rebuild and participate in live context revisions. The audit records assembled role/transport instructions. Output schemas and validation remain code-owned. [IDE helpers](../docs/ide-helpers.md) are separately callable from Codex, Claude Code and Copilot.

The [RESTaurant live example](../examples/restaurant/README.md) documents `restaurant:setup`, `restaurant:doctor`, `restaurant:run`, watch, optional source repair and cleanup. These wrappers keep the example target isolated from the default offline fixtures.

## Related

- [Crash course](README.md)
- [Bring your own API](walkthroughs/03-bring-your-own-api.md)
- [Configuration explanation](../docs/configuration.md)
- [Architecture and trust boundaries](../docs/architecture.md)
