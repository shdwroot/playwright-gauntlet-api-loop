# Live example: Damn Vulnerable RESTaurant

Use a disposable local RESTaurant API to learn the full Gauntlet loop: import context, discover scenarios with a real LLM, compile Playwright tests, execute, inspect failures, repair within scope and rerun. The framework remains generic; this is one optional example.

## 1. Install and start the lab

From the Gauntlet repository root, install Node.js 20.12+, Git, Python 3 for optional source verification, and Docker with Compose v2. Start Docker, then:

```bash
npm ci
npm run restaurant:setup
```

Setup fetches the [upstream project](https://github.com/theowni/Damn-Vulnerable-RESTaurant-API-Game/tree/d32d09972aec7830f5f1d4a5d274cac7aae7eb82) at the pinned revision, copies this example's deployment files, builds the image, migrates the database and waits for health. It makes GitHub, image-registry and package-download requests, but no LLM calls. The first build can take several minutes.

Only the API is published, at `127.0.0.1:8091`. PostgreSQL stays on the Compose network. The example does not use upstream's privileged Compose setup, publish the database, mount host source or grant host capabilities. Application vulnerabilities remain; container-escape challenges are outside this example.

If port 8091 is occupied, setup stops without changing that service. Choose a free port:

```bash
npm run restaurant:setup -- --port 8092
```

Subsequent `restaurant:*` commands use the port recorded in `.gauntlet/restaurant-example/lab.json`. Setup refuses to overwrite an existing checkout. If the first build was interrupted after the manifest was written, inspect logs and resume the build with:

```bash
docker compose --project-directory .gauntlet/restaurant-example/api -f .gauntlet/restaurant-example/api/compose.lab.yml up --build -d --wait --wait-timeout 180
```

If cloning was interrupted before a manifest exists, inspect `.gauntlet/restaurant-example/api` and move that incomplete checkout aside before retrying setup. Never reset a repaired checkout blindly.

## 2. Check the running API

```bash
npm run restaurant:status
npm run restaurant:doctor
```

Compose should show healthy `web` and `db` services. Doctor should report `ok: true` and a nonzero operation count. Doctor downloads the live contract and copies context; it does not make LLM calls or execute tests.

For the default port:

- API: <http://127.0.0.1:8091>
- Swagger UI: <http://127.0.0.1:8091/docs>
- Contract: <http://127.0.0.1:8091/openapi.json>
- Health: <http://127.0.0.1:8091/healthcheck>

Use your selected port in browser URLs. If you already have a separately managed lab, use the generic command with its URL rather than adopting it into this setup:

```bash
npm run gauntlet -- doctor --url http://127.0.0.1:8091/openapi.json --context examples/restaurant/context --project-dir .gauntlet/my-existing-restaurant
npm run gauntlet -- run --url http://127.0.0.1:8091/openapi.json --context examples/restaurant/context --project-dir .gauntlet/my-existing-restaurant
```

The `run` line requires the model configuration in the next section and executes real tests; use doctor alone for setup validation.

## 3. Configure a real LLM

Create the repository `.env` from [.env.example](../../.env.example) only if it does not already exist. Add `OPENAI_API_KEY` for the default Luna configuration, or select Azure:

```dotenv
GAUNTLET_AGENT_PROVIDER=azure
AZURE_OPENAI_ENDPOINT=https://YOUR-RESOURCE.openai.azure.com
AZURE_OPENAI_API_KEY=YOUR-KEY
AZURE_OPENAI_DEPLOYMENT=YOUR-DEPLOYMENT-NAME
```

Use an Azure deployment supporting Responses and structured JSON-schema output. Unset `GAUNTLET_AGENT_MODEL` if using `AZURE_OPENAI_DEPLOYMENT`. IDE model selection does not configure these runtime calls. See [provider configuration](../../docs/configuration.md#azure-openai). Never paste keys into prompts or commit `.env`.

## 4. Trigger the full loop

```bash
npm run restaurant:run
```

This makes paid model calls and real requests to the disposable API, including declared mutations. It invokes discovery, lead, builder, verifier, critic and healer as needed. It can repair test implementation errors; it does not modify API source unless source repair is enabled below. This is the actual Gauntlet agent loop, not a separate hand-written application test suite.

The starter [requirements](context/requirements.json) contain eight requirements and eleven independently tracked criteria. They cover health, registration, duplicate registration, form login, profiles, missing credentials, menu shape and protected profile fields. Security targets describe desired behavior and may fail on the original app. The model also analyzes the complete imported contract for additional scenarios. A passing starter criterion set is not exhaustive coverage.

For a staged learning run:

```bash
npm run restaurant:discover
npm run restaurant:generate
npm run restaurant:run
```

Discovery and generation each make model calls; they do not execute target tests. Each command refreshes the contract through URL onboarding. A later run can generate a different plan; it is not a frozen replay of the earlier generation. The loop command already includes these phases, so staging is optional.

## 5. Inspect the report and ask a helper

The final output prints the report location and verified/outstanding obligations. Look under:

```text
.gauntlet/restaurant-example/
  api/                         # disposable upstream source checkout and Compose files
  lab.json                     # selected port and pinned upstream revision
  project/
    gauntlet.config.json       # generated target configuration
    openapi.yaml               # imported contract
    context/                   # copied example requirements and guidance
    .gauntlet/runs/<run-id>/
      analysis.md
      analysis.json
      coverage-backlog.json
      scenario-ledger.json
      agents/calls/
      attempts/
```

Interpret `PASSED`, `FAILED`, `BLOCKED` and `STALLED` using [the reference](../../training/reference.md#terminal-statuses). Tests passed, tests linked to criteria, and criteria semantically verified are different counts. Preserve failed attempts and unverified obligations.

Use `gauntlet-api-analysis` for onboarding and `gauntlet-failure-analysis` for the saved run. [Codex, Claude Code and Copilot invocation examples](../../docs/ide-helpers.md) explain the syntax. Give the helper the exact run directory; do not substitute a different target's latest run.

## 6. Optional source repair and unattended maintenance

To allow the developer role to modify this disposable API checkout, verify Python 3 is available locally and run:

```bash
npm run restaurant:run -- --workflow source-repair --source auto
```

Gauntlet recognizes the loopback Compose deployment, configures scoped `app/` edits and the RESTaurant fixture integration, validates syntax, restarts the service and reruns unchanged tests. This changes the lab source and running image. It does not repair framework code or automatically prove all security criteria. The generic source-repair interface and adapter limits are documented in [autonomous onboarding](../../docs/autonomous-onboarding.md#api-source-repair).

Use `npm run restaurant:test` to explicitly select tests-only, or `npm run restaurant:repair` to select source-repair and discover this lab checkout. Tests-only overrides a saved source-repair mode and disables API source editing. The saved source configuration and independent fixture adapter can remain for future use.

For repeated execution after context changes:

```bash
npm run restaurant:run -- --watch
```

The selected workflow persists for URL-onboarded projects. Pass `--workflow tests-only` to disable API source editing, or `--workflow source-repair` to enable the configured source repair. Edit `examples/restaurant/context/` to add requirements; original sources are reimported. Edit [prompts/](../../prompts/README.md) to change runtime instructions without rebuilding. Prompt edits invalidate cached candidates and trigger another watch cycle. If context changes mid-run, that result is blocked for the new revision. Ctrl+C stops monitoring after the active run.

## 7. Stop, resume and inspect residue

```bash
npm run restaurant:logs
npm run restaurant:down
npm run restaurant:up
```

`down` removes only this example's containers/network and preserves its dedicated database volume, source edits and Gauntlet reports. `up` resumes them. The setup helper never resets an existing checkout or deletes a volume. To erase this lab's database intentionally, stop watch mode and then run the explicitly destructive command:

```bash
docker compose --project-directory .gauntlet/restaurant-example/api -f .gauntlet/restaurant-example/api/compose.lab.yml down --volumes
```

That command erases only this Compose project's named database volume. It does not undo source repairs. Keep a report/source diff before moving or removing the ignored checkout to start over from the pinned revision.

## Troubleshooting and validation limits

| Symptom | Next check |
| --- | --- |
| Port occupied | Choose another setup port, or use the existing API through generic URL onboarding |
| Build or health wait failed | `restaurant:logs`; check Docker, image/package downloads and migrations, then resume the explicit build above |
| Missing model key | Set the configured credential variable in repository `.env` |
| Quota exhausted | Restore provider credits; no offline agent is substituted |
| Temporary HTTP 429 | Provider retries are bounded; inspect recorded error and retry output |
| Auth/fixture gap | Check actual login/setup evidence; never assume seeded credentials or inject staff privileges through a vulnerability |
| API security criterion fails | Keep it failed unless an authorized source repair passes a fresh regression |
| Unknown oracle/unsupported capability | Retain the gap; do not lower gates or redefine the requirement |

The application revision and Python dependency versions are pinned. Base-image tags and external package availability can change, so builds are not claimed to be byte-for-byte reproducible. Earlier repaired local runs are historical evidence, not acceptance of this fresh upstream example. The fresh example was checked on loopback port 8092: both services became healthy, doctor loaded 21 operations, all eleven starter criteria mapped, four actor profiles authenticated, the 101-order fixture was observed and six namespace-owned users were cleaned up. No new LLM acceptance run was performed. See [current validation](../../docs/validation.md) for evidence and limits.
