# How to test your own API

The quickest path is to provide the API contract URL and context:

```bash
npm run gauntlet -- run --url http://127.0.0.1:8091/openapi.json --context context/requirements.json --source auto
```

Gauntlet imports the contract, discovers scenarios with Luna, generates and executes Playwright tests, attempts configured repairs and writes a report. Add `--watch` to repeat when the original context changes. `--source auto` enables source repair only for supported local Compose projects; omit it when testing without an application checkout. Repeat `--context` for additional files or directories. See [automatic onboarding](../../docs/autonomous-onboarding.md) for fixture/deployment adapter scope.

The remaining steps describe manual configuration for environments that need custom authentication, isolation or deployment commands.

## Prerequisites

- Node.js 20.12 or newer
- An OpenAPI 3.x JSON/YAML URL or local file
- A target environment whose data may safely be read or mutated by the planned cases
- Credential environment-variable names and values, if the API is secured

Start with a local or disposable test environment. Do not point the first generated plan at production.

## Step 1: Create a workspace for the contract

```bash
mkdir -p my-api-gauntlet
cp training/example-project/openapi.yaml my-api-gauntlet/openapi.yaml
```

Replace `my-api-gauntlet/openapi.yaml` with your contract. The commands create a starter example; review existing files before copying over your own contract. The config loader intentionally requires the spec, generated directory, and artifact directory to remain inside the config directory.

## Step 2: Make the contract generation-ready

Check these contract requirements:

- `openapi` begins with `3.`.
- Every operation has a unique, non-empty `operationId`.
- Every operation declares at least one numeric response such as `"200"`.
- Request bodies intended for generation use `application/json`, a `+json` media type, or `application/x-www-form-urlencoded`.
- Every `$ref` is local and begins with `#/`.
- Required fields, examples, formats, enums, and min/max constraints describe inputs your test environment can accept.
- Secured operations declare `401` if you want missing-credential cases.
- Path operations declare `404` if you want not-found cases.
- Create operations declare `409` and a known `x-gauntlet-conflict-value` if you want deterministic conflict cases.

The contract is the test oracle. If it is stale, the framework will faithfully test the wrong expectation.

## Step 3: Bound the target in config

Create `my-api-gauntlet/gauntlet.config.json`:

```json
{
  "projectName": "my-api",
  "spec": "openapi.yaml",
  "baseUrl": "http://127.0.0.1:8080",
  "generatedDir": ".gauntlet/generated",
  "artifactsDir": ".gauntlet/runs",
  "seed": 42,
  "maxIterations": 3,
  "timeoutMs": 30000,
  "headersFromEnv": {
    "authorization": "MY_API_AUTHORIZATION"
  },
  "safety": {
    "allowedHosts": ["127.0.0.1"],
    "allowedMethods": ["GET"],
    "allowDestructive": false,
    "allowProduction": false,
    "maxRequestsPerRun": 100,
    "maxResponseBytes": 65536
  },
  "agents": {
    "provider": "openai",
    "builderModel": "gpt-5.6-luna",
    "criticModel": "gpt-5.6-luna"
  },
  "quality": {
    "minimumScore": 95,
    "minimumOperationCoverage": 1
  }
}
```

This minimal config performs live contract-only discovery. Add `"discovery": {"enabled": true, "required": true, "sources": ["context"]}` and create `my-api-gauntlet/context/` for supporting requirements/logs. A local OpenAPI 3 contract is still mandatory.

Begin with `GET` only. If the contract contains mutations, doctor can still load it, but the planner will mark denied operations uncovered and a 100 percent coverage gate will prevent a false pass.

Only add `POST`, `PUT`, `PATCH`, or `DELETE` after reviewing the exact target and cases. Those methods also require `allowDestructive: true`.

## Step 4: Map credential names, not values

Put `OPENAI_API_KEY` in the untracked `my-api-gauntlet/.env` or export it privately. The root `.env` is not loaded for this nested config. You can also set `GAUNTLET_BASE_URL` there to override `baseUrl`; update the target allowlist accordingly. Existing exports win.

For a bearer token:

```bash
export MY_API_AUTHORIZATION='Bearer replace-with-test-token'
```

The config stores only `MY_API_AUTHORIZATION`, the environment-variable name. The runtime loads its value inside the Playwright worker.

For multiple headers:

```json
{
  "headersFromEnv": {
    "authorization": "MY_API_AUTHORIZATION",
    "x-tenant-id": "MY_API_TENANT_ID"
  }
}
```

## Step 5: Validate without contacting the target

```bash
npm run gauntlet -- doctor --config my-api-gauntlet/gauntlet.config.json
```

Doctor should report `"ok": true` and the expected operation/workflow counts. Fix config and contract errors before enabling more methods or running a target.

## Step 6: Generate without executing

If you configured logs or documents, inspect their decisions first:

```bash
npm run gauntlet -- discover --config my-api-gauntlet/gauntlet.config.json
```

Discovery and generation contact the model provider but do not execute target requests. Resolve unexpected `report-only`/`reject` findings, source errors, and contract gaps before generating. See [Walkthrough 4](04-context-discovery.md).

```bash
npm run gauntlet -- generate --config my-api-gauntlet/gauntlet.config.json
```

Review `my-api-gauntlet/.gauntlet/generated/plan.generated.json`. A quick coverage report:

```bash
node -e "const p=require('./my-api-gauntlet/.gauntlet/generated/plan.generated.json'); console.table(p.operations.map(o=>({operation:o.operationId,cases:o.coveredBy.length,blocked:o.blockedReason||''})))"
```

Do not run until every unexpected method, path, body, credential use, and workflow has been resolved.

## Step 7: Run the target

Start your API separately, then execute:

```bash
npm run gauntlet -- run --config my-api-gauntlet/gauntlet.config.json
```

The run generates through real agents, verifies artifact integrity, executes with one worker and zero retries, reviews semantic coverage/isolation, and critiques/heals within the configured bounds. A prior standalone `generate` does not freeze the next live plan; safety policy still constrains every new proposal.

For continued maintenance, use `npm run gauntlet -- run --watch --config my-api-gauntlet/gauntlet.config.json`. It detects configured context changes and prints an analysis report per run. Restart it after `.env` changes. A target-only outage recovery does not change context; use a one-shot run to retry.

## Step 8: Verify the claimed layer

Use the printed run ID:

```bash
npm run gauntlet -- report <run-id> --config my-api-gauntlet/gauntlet.config.json
```

A `PASSED` result proves the generated cases passed against that target during that run. It does not prove ungenerated business rules, browser behavior, load capacity, or another environment.

For a failure, follow the evidence order in [Walkthrough 2](02-evidence-and-healing.md).

## Add a workflow

Use a workflow when a later request needs data created by an earlier response:

```yaml
x-gauntlet-workflows:
  create-read-delete:
    description: Create, read, and delete one disposable record.
    steps:
      - id: create
        operationId: createRecord
        request:
          body:
            name: Course Record
        capture:
          recordId: $response.body#/id
      - id: read
        operationId: getRecord
        parameters:
          id: ${steps.create.recordId}
      - id: delete
        operationId: deleteRecord
        parameters:
          id: ${steps.create.recordId}
```

Workflow request overrides must still satisfy the operation's request schema. The response capture must exist, or execution fails with `CAPTURE_MISSING`.

If an operation is safe only with workflow-created data, set `x-gauntlet-skip-standalone: true` on that operation. The workflow can still count as its coverage.

## Choose isolation and understand repair boundaries

Do not copy the sample's reset operation into a target that lacks it. If your test API has a declared, permitted reset operation, configure [per-test reset hooks](../../docs/configuration.md#optional-test-environment-reset). Otherwise, agents need supported setup, captures and cleanup to keep tests independent. Reset and cleanup requests count against the cumulative live budget.

The OpenAPI-extension example above puts delete in the main sequence: it will not run after a preceding failed main step. Agent-authored workflows can put resource deletion in `cleanupSteps`, which runs after failure. Existing expectations remain immutable; additions can strengthen tests, but arbitrary capture/order/code repairs are not supported.

For repeatable offline baseline generation, explicitly choose `agents.provider: "deterministic"` with model labels such as `deterministic-v1`, or use the training config. This turns off live discovery/authoring/verifier calls; it is not the autonomous mode.

## Verification checklist

- [ ] Doctor reports the expected contract identity and counts.
- [ ] Every required operation has at least one `coveredBy` entry.
- [ ] The target host is exact and the intended environment is running.
- [ ] Allowed methods contain nothing unexpected.
- [ ] Destructive access is enabled only when reviewed test data can be changed.
- [ ] Credential values exist only in the environment.
- [ ] Planned requests fit below `maxRequestsPerRun`.
- [ ] Every discovery source and candidate disposition was reviewed; no observation is being treated as an oracle.
- [ ] The final status and critic hard findings were read from saved evidence.
- [ ] Failure traces and exchanges were reviewed before changing API or contract behavior.

## Troubleshooting

### `CONTRACT_DUPLICATE_OPERATION_ID`

Give every operation a unique `operationId`. The error includes both conflicting source pointers.

### `CONTRACT_REF_DENIED`

Bundle remote schemas into the local OpenAPI document and use a `#/components/...` reference.

### `COVERAGE_GAP`

Read `operations[*].blockedReason` in the generated plan. Common causes are a denied HTTP method, destructive access left off, a skipped standalone operation with no workflow, or no declared `2xx` response.

### `REQUEST_BUDGET_EXCEEDED`

Review why the contract generates that many standalone cases and workflow steps. Raise the budget only after the full planned request set is intentional.

### `CONTRACT_ASSERTION_FAILED`

Open the failing exchange and compare the response with the immutable contract. Fix whichever is wrong; do not teach the test to accept the observed response automatically.

## Related

- [Framework reference](../reference.md)
- [Configuration](../../docs/configuration.md)
- [Architecture](../../docs/architecture.md)
