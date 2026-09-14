# Configuration

`gauntlet.config.json` is validated before generation or network access.

| Field | Purpose |
|---|---|
| `spec` | Local OpenAPI 3.x JSON or YAML file. Remote `$ref` values fail closed. |
| `baseUrl` | Runtime target. Its hostname must appear in `safety.allowedHosts`. |
| `generatedDir` | Framework-owned output; the healer cannot write elsewhere. |
| `artifactsDir` | Immutable run evidence and reports. |
| `seed` | Reproducible data-generation seed. |
| `maxIterations` | Hard loop budget. Pass, block, unsafe repair, or repetition stops earlier. |
| `headersFromEnv` | Maps HTTP header names to environment-variable names, never values. |
| `discovery` | Optional bounded local log/document sources used only to find OpenAPI-corroborated scenarios. |
| `safety.allowedMethods` | Methods the planner may generate. |
| `safety.allowDestructive` | Required for `POST`, `PUT`, `PATCH`, or `DELETE`. |
| `safety.allowProduction` | Required in addition to host allowlisting for non-loopback targets. |
| `safety.maxRequestsPerRun` | Planning fails before execution if the request budget would be exceeded. |
| `agents.provider` | `deterministic` for offline CI or `openai` for separate live model calls. |
| `quality.minimumScore` | Numeric floor; all hard gates must also pass. |

The default root config uses `openai` and `gpt-5.6-luna` for all five roles. `.env` beside the config is loaded automatically without overriding exported values. `gauntlet.offline.config.json` preserves the deterministic fixture configuration. See [the agentic loop guide](agentic-loop.md).

For OpenAI mode, set `agents.provider` to `openai`, choose separate `builderModel` and `criticModel`, and export the environment variable named by `agents.apiKeyEnv` (default `OPENAI_API_KEY`). The key is not persisted or sent in critic evidence.

Operation-level `security` produces an unauthenticated negative case when a `401` response is declared. Local schema examples, enums, formats, required properties, and numeric/string boundaries drive deterministic data. `x-gauntlet-conflict-value` can name a known duplicate fixture value for a declared `409` case.

Root `x-gauntlet-workflows` entries can capture a response field with `$response.body#/id` and reuse it in later path parameters with `${steps.<step-id>.<capture-name>}`.

## Additional-source discovery

```json
{
  "discovery": {
    "enabled": true,
    "required": true,
    "sources": [
      { "id": "service-events", "path": "context/system.log", "kind": "log" },
      { "id": "api-notes", "path": "context/scenarios.md", "kind": "document" }
    ],
    "allowedExtensions": [".json", ".jsonl", ".log", ".md", ".txt", ".yaml", ".yml"],
    "maxFiles": 100,
    "maxFileBytes": 5242880,
    "maxTotalBytes": 26214400,
    "maxCandidates": 5000,
    "maxCandidatesPerOperation": 20,
    "maxExcerptCharacters": 512,
    "minimumConfidence": 0.85
  }
}
```

Source paths are relative to the config file. A source may be a regular file or a directory; directory traversal is stable and excludes `.git`, `.gauntlet`, and `node_modules`. Symlinks and paths outside the config root fail closed. `kind` may be `log`, `document`, or `auto`. `required: true` makes an empty or missing corpus an error. Every byte/count limit is enforced before candidates enter the plan.

Supported v1 sources are UTF-8 text. PDF, DOCX, archives, remote URLs, devices, sockets, and binary or malformed encodings are deliberately rejected; extract them into reviewed text first. Do not configure generated or run directories as inputs.

Use method, path, status, and a concise symptom to maximize mapping accuracy, for example:

```text
method=POST path=/users status=400 error="malformed JSON"
GET /users?limit=0 returned 400 query minimum boundary
POST /users with whitespace-only name should return 422
```

Observed values are never test oracles. A candidate is executable only when the method/path has one exact OpenAPI match, the status is declared, policy permits the operation, and the input can be synthesized from the contract. See the [discovery walkthrough](../training/walkthroughs/04-context-discovery.md).

For a complete field-by-field table, see the [framework reference](../training/reference.md#configuration). To build a bounded config for another service, follow [How to test your own API](../training/walkthroughs/03-bring-your-own-api.md).

Agent role overrides: `agents.discoveryModel`, `agents.leadModel`, and `agents.healerModel` default to `builderModel`. `agents.timeoutMs` defaults to 120000. `discovery.maxAgentInputCharacters` defaults to 200000. Agentic runs enforce `safety.maxRequestsPerRun` cumulatively across reruns.
