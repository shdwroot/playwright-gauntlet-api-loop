# Framework reference

Use this page when you know what you want to do and need the exact command, setting, generated case rule, status, or evidence path. Start with the [crash course](README.md) if this is your first run.

## Requirements

- Node.js 20 or newer
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
| `generate` | `--config <path>` | Compiles the contract-derived plan and writes the generated plan, Playwright test, and signed manifest. |
| `run` | `--config <path>`, `--inject-stale-data` | Generates, executes, critiques, and, when policy permits, heals and reruns the suite. `loop` is an accepted alias for `run`. |
| `report` | `<run-id-or-directory>`, `--config <path>` | Prints the saved `result.json`. A bare run ID is resolved beneath the configured `artifactsDir`. |

The default config path is `gauntlet.config.json` in the current directory.

### Exit codes

| Code | Meaning |
|---:|---|
| `0` | The command completed; for `run`, every hard gate passed. |
| `1` | The API or framework failed a run. |
| `2` | The run was blocked by infrastructure or stopped after repeating the same candidate and failure fingerprint. |
| `3` | The CLI, configuration, contract, credential, or runtime setup is invalid. |

## Configuration

Paths are resolved relative to the directory containing the selected config file.

### Top-level fields

| Field | Required | Default | Rules and effect |
|---|---:|---:|---|
| `projectName` | Yes | None | Non-empty name written into plans and run evidence. |
| `spec` | Yes | None | Local OpenAPI file. It must stay within the config directory. |
| `baseUrl` | Yes | None | HTTP(S) target. Its hostname must be allowlisted. |
| `generatedDir` | Yes | None | Framework-owned plan, test, and manifest directory. It must stay within the config directory. |
| `artifactsDir` | Yes | None | Run evidence directory. It must stay within the config directory. |
| `seed` | No | `42` | Finite number used for repeatable generated data and stable case IDs. |
| `maxIterations` | No | `3` | Floored to an integer and clamped to at least `1`. |
| `timeoutMs` | No | `30000` | Per-test timeout, clamped to at least `1000` milliseconds. |
| `headersFromEnv` | No | `{}` | Maps lowercase HTTP header names to environment-variable names. Values never belong in config. |

### `safety`

The `safety` object is required.

| Field | Required | Default | Rules and effect |
|---|---:|---:|---|
| `allowedHosts` | Yes | None | Array of exact hostnames accepted by `baseUrl`. |
| `allowedMethods` | Yes | None | Non-empty subset of `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, and `OPTIONS`. Other values fail configuration validation. |
| `allowDestructive` | No | `false` | Must be `true` before the planner accepts `POST`, `PUT`, `PATCH`, or `DELETE`. |
| `allowProduction` | No | `false` | Must be `true` for any non-loopback target, in addition to exact host allowlisting. |
| `maxRequestsPerRun` | No | `100` | Planning fails if cases plus workflow steps exceed this budget. Clamped to at least `1`. |
| `maxResponseBytes` | No | `65536` | Maximum response text retained and checked by the worker. Clamped to at least `1024`. |

Loopback hostnames are `localhost`, `127.0.0.1`, and `::1`.

### `agents`

The `agents` object and both model names are required.

| Field | Required | Default | Rules and effect |
|---|---:|---:|---|
| `provider` | Yes | None | `deterministic` keeps runs offline; `openai` makes separate builder and critic Responses API calls. |
| `builderModel` | Yes | None | Model label or OpenAI model used for builder risk notes. The deterministic compiler still owns executable output. |
| `criticModel` | Yes | None | Model label or OpenAI model used for critic findings. Hard gates remain authoritative. |
| `openaiBaseUrl` | No | `https://api.openai.com` | Base URL used only by the OpenAI provider. |
| `apiKeyEnv` | No | `OPENAI_API_KEY` | Name of the environment variable containing the OpenAI API key. |

### `quality`

The `quality` object is required.

| Field | Required | Default | Rules and effect |
|---|---:|---:|---|
| `minimumScore` | No | `95` | Numeric pass floor clamped to `0..100`. It cannot override a hard finding. |
| `minimumOperationCoverage` | No | `1` | Required covered-operation ratio clamped to `0..1`. `1` means 100 percent. |

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

The planner is deterministic: the same normalized contract, config, and seed produce the same plan.

| Kind | Generated when | Expected result |
|---|---|---|
| `positive` | An allowed, non-skipped operation declares at least one `2xx` response. | Any declared `2xx` status, plus declared content type and schema. |
| `validation` | A `422` response, or otherwise a `400`, is declared and the request has required or bounded input. | The selected validation status. |
| `boundary` | The operation has an object-like or bounded request body. | Declared success using maximum or minimum boundary values. |
| `authorization` | The operation is secured and declares `401`. | `401` with configured credentials intentionally omitted. |
| `not-found` | The operation has a path parameter and declares `404`. | `404` using a deterministic missing identifier. |
| `conflict` | The operation has a request body and declares `409`. | `409`, normally using `x-gauntlet-conflict-value`. |

Each workflow becomes one serial Playwright test, even when it performs several requests. The request budget counts every workflow step.

## Runtime assertions

For every generated case, the worker:

1. Loads configured credentials from environment variables.
2. Substitutes captured workflow values.
3. Sends the request with `failOnStatusCode: false` so the contract controls acceptance.
4. Attaches a redacted request/response exchange.
5. Checks status, declared content type, and the supported JSON Schema subset.
6. For positive object requests, checks matching response fields round-trip unchanged.

The schema checker covers object properties and required fields, `additionalProperties: false`, arrays and item counts, strings and formats, numeric bounds, enums, constants, nullability, `allOf`, `anyOf`, and `oneOf`.

## Critic score and hard gates

The deterministic score totals 100 points:

- 40: execution passed with zero failed tests
- 25: operation coverage ratio
- 15: executed test count matches the signed plan, with no skips
- 10: artifact integrity and contract hash match
- 10: no forbidden test controls or invalid traceability

Every blocking model finding subtracts 10 points, but score alone never passes a run. Zero tests, count mismatch, skips, target failure, contract assertion failure, artifact mismatch, forbidden `skip`/`only`/`fixme`, invalid traceability, or insufficient coverage remains blocking.

## Terminal statuses

| Status | Meaning |
|---|---|
| `PASSED` | No blocking findings remain and the score meets `minimumScore`. |
| `FAILED` | A product/contract failure is not safely healable, or the iteration budget ended. |
| `BLOCKED` | The target was unreachable. Assertions are preserved and the run stops. |
| `STALLED` | The same plan and failure fingerprint repeated, so the loop stopped rather than retrying forever. |

## Evidence layout

```text
<artifactsDir>/<run-id>/
  run-manifest.json
  events.json
  plan.json
  generated-manifest.json
  agents/builder.json
  attempts/<iteration>/
    execution.json
    playwright-report.json
    junit.xml
    html/index.html
    stdout.log
    stderr.log
    critic.json
    heal.json
    test-results/
  heal-<iteration>.diff
  result.json
```

`run-manifest.json` records the contract/config identity, seed, target origin, source revision, and agent identities. `events.json` is the ordered state ledger. `result.json` is the terminal summary. Attempt directories contain the raw execution and critic evidence needed to audit the verdict.

## Related

- [Crash course](README.md)
- [Bring your own API](walkthroughs/03-bring-your-own-api.md)
- [Configuration explanation](../docs/configuration.md)
- [Architecture and trust boundaries](../docs/architecture.md)
