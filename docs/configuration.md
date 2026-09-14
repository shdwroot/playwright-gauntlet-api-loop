# Configuration

Select a project with `--config path/to/gauntlet.config.json`. Paths and automatic `.env` loading are relative to that configuration's directory. The complete field/default tables are in the [framework reference](../training/reference.md#configuration).

## Endpoint and environment

`baseUrl` selects the API under test. A nonblank `GAUNTLET_BASE_URL` overrides it; blank or unset falls back to config. The resulting hostname must be in `safety.allowedHosts`; non-loopback targets also require `allowProduction: true`. Mutating methods require both the method allowlist and `allowDestructive: true`.

```dotenv
# In the untracked .env beside the chosen config:
GAUNTLET_BASE_URL=http://127.0.0.1:8080
# Add OPENAI_API_KEY and your target credentials privately.
```

Exported environment variables take precedence over `.env`. Only the selected config's adjacent `.env` is loaded, not every parent directory. Existing environment values also persist in a running watcher: restart it after changing credentials or `.env` target/model values; `.env` is not a watched source.

`headersFromEnv` maps header names to environment-variable names, for example `{"authorization":"MY_API_AUTHORIZATION"}`. Store the full bearer value privately in that variable. Do not place credential values in JSON config or context documents.

## Models and modes

The root config uses six live Luna roles. `gauntlet.offline.config.json` and the inventory training config are deterministic. With live mode, discovery analyzes the contract even if supplemental discovery sources are disabled.

| Setting | Effect |
| --- | --- |
| `agents.provider` | `openai` for actual model calls; `deterministic` for offline fixtures |
| `builderModel`, `criticModel` | Required role model names |
| `discoveryModel`, `leadModel`, `healerModel` | Default to builder model |
| `verifierModel` | Defaults to critic model |
| `agents.timeoutMs` | Per-model-call timeout, default 120000 ms |
| `agents.apiKeyEnv` | Credential variable name, default `OPENAI_API_KEY` |
| `agents.openaiBaseUrl` | Model provider endpoint; separate from the target API's `baseUrl` |

`--agentic --model MODEL_ID` selects live mode and overrides all role models for that invocation. `OPENAI_MODEL` supplies the model only when `--agentic` is used without `--model`. `GAUNTLET_AGENT_PROVIDER` and `GAUNTLET_AGENT_MODEL` directly override provider/model configuration; clear them when switching to offline exercises. There is no silent fallback from a failed model call to a scripted agent.

## Supporting context

```json
{
  "discovery": {
    "enabled": true,
    "required": true,
    "sources": [{ "id": "project-context", "path": "context", "kind": "auto" }],
    "maxAgentInputCharacters": 200000,
    "minimumConfidence": 0.85
  }
}
```

Create the configured directory and add UTF-8 context before running. Sources may be files or directories; supported kinds are `auto`, `log` and `document`. Directory sources include newly added files. Paths must remain under the config root; symlinks, binaries, unsupported extensions and size/count overflow fail closed. Keep generated artifacts and secrets out of discovery inputs.

Default extensions are `.json`, `.jsonl`, `.log`, `.md`, `.txt`, `.yaml`, `.yml`. PDF/DOCX extraction, WSDL/SOAP, Swagger 2 conversion and structured Gherkin are not implemented. A text export can provide context alongside the mandatory OpenAPI 3 contract; it does not become an authoritative replacement contract.

Live discovery analyzes prose and observable API semantics. Deterministic extraction supports narrower method/path/status recipes; see the [offline discovery exercise](../training/walkthroughs/04-context-discovery.md). Observed statuses cannot replace declared expectations.

## Coverage and budgets

- `quality.minimumOperationCoverage` defaults to `1`; it measures operations, not all business behavior.
- `quality.minimumScenarioCoverage` defaults to `1` for live mode and `0` for deterministic mode; it checks eligible AI scenario implementation links.
- `quality.requireSemanticVerification` and `quality.requireIsolationReview` default to true in live mode. The verifier must reference actual assertions from linked tests that passed, and review each independent test's isolation. Disabling a gate reduces assurance.
- `quality.minimumScore` defaults to `95`; no score overrides a blocking finding.
- `maxIterations` bounds executions. In live mode, `safety.maxRequestsPerRun` is cumulative across reruns and includes main steps, workflow cleanup and per-test reset hooks. The loader default is 100; the bundled live sample sets 400 to accommodate reset requests.

See [the agentic guide](agentic-loop.md) for retained obligations, semantic reconciliation, watch behavior and stopping conditions.

## Optional test-environment reset

For live mode and a disposable target with a declared reset endpoint:

```json
{
  "isolation": {
    "operationId": "resetFixture",
    "request": { "headers": { "x-gauntlet-reset": "allowed" } }
  }
}
```

This is the bundled sample's operation and guard header, not a universal API setting. The compiler validates the operation, success response, request and safety policy, then runs reset before and after every standalone test or workflow. Configured reset hooks cannot reference workflow variables. Omit this setting for targets without that capability; agents must establish independent state through supported setup/cleanup instead.

Agent-authored `cleanupSteps` run in `finally`. Cleanup failures remain visible alongside the original error. A stopped process or unreachable target can prevent cleanup; the framework cannot guarantee removal in those conditions.

## Contract conventions

Declared security plus `401` enables missing-credential cases. Examples, enums, required properties and boundaries drive the baseline planner. `x-gauntlet-conflict-value` supplies a known fixture duplicate for `409` tests.

OpenAPI `x-gauntlet-workflows` uses `$response.body#/id` captures and `${steps.create.itemId}` references. Agent proposals use `capture: {itemId: "$.id"}` and `${itemId}`. These are different input syntaxes; the loader/compiler normalizes them to runtime captures. The OpenAPI extension currently has main `steps` only: deleting in a final main step does not provide failure-path cleanup. See [agent-authored cleanup](agentic-loop.md#cleanup-and-isolation).
