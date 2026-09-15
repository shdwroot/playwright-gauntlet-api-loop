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
| `agents.provider` | `openai` or `azure` for actual model calls; `deterministic` for offline fixtures |
| `builderModel`, `criticModel` | Required role model names |
| `discoveryModel`, `leadModel`, `healerModel` | Default to builder model |
| `verifierModel` | Defaults to critic model |
| `agents.timeoutMs` | Per-model-call timeout, default 120000 ms |
| `agents.apiKeyEnv` | Credential variable name; default `AZURE_OPENAI_API_KEY` for Azure, otherwise `OPENAI_API_KEY` |
| `agents.openaiBaseUrl` | OpenAI-compatible model endpoint; separate from the target API's `baseUrl` |
| `agents.azureEndpoint` | Azure resource URL or `/openai/v1/` base; overridden by `AZURE_OPENAI_ENDPOINT` |

`--agentic --model MODEL_ID` preserves Azure when selected, otherwise selects OpenAI live mode and overrides all role models for that invocation. For OpenAI, `OPENAI_MODEL` supplies the fallback with `--agentic` or URL onboarding when `--model` is omitted; Azure uses deployment names instead. `GAUNTLET_AGENT_PROVIDER` and `GAUNTLET_AGENT_MODEL` directly override provider/model configuration; clear them when switching to offline exercises. There is no silent fallback from a failed model call to a scripted agent.

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

## Azure OpenAI

Set these in the `.env` beside your config (the repository `.env` for URL onboarding):

```dotenv
GAUNTLET_AGENT_PROVIDER=azure
AZURE_OPENAI_ENDPOINT=https://YOUR-RESOURCE.openai.azure.com
AZURE_OPENAI_API_KEY=YOUR-KEY
AZURE_OPENAI_DEPLOYMENT=YOUR-DEPLOYMENT-NAME
```

Then run the same loop:

```bash
npm run gauntlet -- run --url http://127.0.0.1:8080/openapi.json --context ./your-api/requirements.json --watch
```

The LLM endpoint is separate from the API being tested. Azure uses `POST /openai/v1/responses`, the `api-key` header, and the deployment name in `model`, following [Microsoft's Responses API documentation](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/responses). Resource URLs and `/openai/v1/` base URLs are accepted. This integration uses v1, so it does not need `api-version`; legacy deployment-specific preview URLs are rejected. Entra ID token acquisition and refresh are not implemented.

`GAUNTLET_AGENT_MODEL` overrides `AZURE_OPENAI_DEPLOYMENT`; either applies to all agent roles. For separate deployments, leave both unset and set the role model fields in config. An explicit `--model` during URL onboarding or with `--agentic` overrides every role. Azure onboarding preserves the selected provider and role deployments when refreshed. `OPENAI_MODEL` does not select an Azure deployment.

Choose an Azure deployment supporting both Responses and structured JSON-schema output. All live discovery, management, building, verification, critique, healing and configured developer calls use Azure; quality gates, evidence retention and retry limits are unchanged. Provider failures never select offline agents. `npm run agentic:verify` and `npm run maintenance:verify` also honor Azure configuration and make paid calls when run.

## Repair workflows and API source checkout

`workflow` is `tests-only` by default, including older configs with a `sourceRepair` section. Set `GAUNTLET_WORKFLOW` or pass `--workflow` to override it (CLI wins). URL onboarding saves the selected mode; config-based CLI overrides apply to that invocation. The console, doctor, result JSON and analysis report identify the effective mode.

```dotenv
GAUNTLET_WORKFLOW=tests-only
GAUNTLET_API_SOURCE=/absolute/path/to/your-api-repo
```

The source variable identifies a **local API repository checkout**, separate from `GAUNTLET_BASE_URL`. It is not a Git remote URL and does not clone a repository. Use an absolute path. Tests-only ignores this source setting and disables the developer source editor even if earlier runs retained repair configuration. It still executes API requests, including configured mutations and fixture setup; it is not a read-only HTTP mode. API defects remain failures/findings rather than being hidden by weakened tests.

```bash
npm run gauntlet -- run --config path/to/gauntlet.config.json --workflow tests-only
npm run gauntlet -- run --config path/to/gauntlet.config.json --workflow source-repair
```

Source-repair requires live agents and scoped `sourceRepair` configuration: `root`, `include`, `verifyCommand`, `restartCommand`, and optional attempt/time limits. A supported loopback Python Compose app can infer these from `GAUNTLET_API_SOURCE`, or from `--source auto|path` during URL onboarding. Other APIs need owner-configured commands; a source path alone cannot tell Gauntlet how to validate and redeploy an arbitrary application. Commands are argument arrays executed in the source root. Verification should include the application's relevant checks. An environment path differing from an existing configured root fails with `SOURCE_ROOT_MISMATCH`; review that checkout's commands before updating the config.

Source-repair can repair test implementation defects and evidenced API defects. Source edits are scoped, diffed, verified and restarted; failed verification triggers rollback. The failing test plan is retained for the next execution. Inspect `attempts/*/source-heal.json` and linked diff/validation evidence to distinguish an API repair from a test repair. Neither mode promises that every failure can be repaired.
