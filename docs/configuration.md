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
| `safety.allowedMethods` | Methods the planner may generate. |
| `safety.allowDestructive` | Required for `POST`, `PUT`, `PATCH`, or `DELETE`. |
| `safety.allowProduction` | Required in addition to host allowlisting for non-loopback targets. |
| `safety.maxRequestsPerRun` | Planning fails before execution if the request budget would be exceeded. |
| `agents.provider` | `deterministic` for offline CI or `openai` for separate live model calls. |
| `quality.minimumScore` | Numeric floor; all hard gates must also pass. |

For OpenAI mode, set `agents.provider` to `openai`, choose separate `builderModel` and `criticModel`, and export the environment variable named by `agents.apiKeyEnv` (default `OPENAI_API_KEY`). The key is not persisted or sent in critic evidence.

Operation-level `security` produces an unauthenticated negative case when a `401` response is declared. Local schema examples, enums, formats, required properties, and numeric/string boundaries drive deterministic data. `x-gauntlet-conflict-value` can name a known duplicate fixture value for a declared `409` case.

Root `x-gauntlet-workflows` entries can capture a response field with `$response.body#/id` and reuse it in later path parameters with `${steps.<step-id>.<capture-name>}`.

For a complete field-by-field table, see the [framework reference](../training/reference.md#configuration). To build a bounded config for another service, follow [How to test your own API](../training/walkthroughs/03-bring-your-own-api.md).
