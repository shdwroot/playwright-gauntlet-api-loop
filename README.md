# Playwright API Gauntlet Loop

Gauntlet runs a maintained API testing loop: AI discovers scenarios from an OpenAPI contract and supporting text, authors typed Playwright API tests, runs them, reviews their assertions and isolation, repairs test implementation faults, and writes an analysis report. The default configuration uses **gpt-5.6-luna** for six roles: discovery, lead, builder, verifier, critic and healer.

OpenAPI statuses and schemas remain authoritative. Real API defects stay red. A passing run certifies the configured gates and executed scenarios, not exhaustive API coverage.

## Start the live agent loop

Requires Node.js **20.12+**, an OpenAPI 3.x contract, a running target and a model API key. From the repository root:

```bash
npm ci
# If .env does not exist, copy .env.example to .env and add OPENAI_API_KEY.
npm run gauntlet -- doctor
```

For the bundled sample, start its disposable API in another terminal:

```bash
node --env-file=.env fixtures/sample-api.mjs
```

Then use one command:

```bash
npm run gauntlet -- run --watch
```

This runs now and reruns when configured context changes. Omit `--watch` for one run. The sample watches `context/`, resets fixture state before and after each independent test, and allows up to 400 API requests across execution attempts, including cleanup and reset hooks.

For your API, follow [the setup walkthrough](training/walkthroughs/03-bring-your-own-api.md). Set `baseUrl` in your config or `GAUNTLET_BASE_URL` in the `.env` beside it. Configure the matching host/method policy; use reset hooks only for a declared reset operation in your own test environment. Exported values take precedence over `.env`.

## What is supported

| Capability | Current support |
| --- | --- |
| API contracts | OpenAPI 3.x YAML/JSON with local references and explicit operation IDs |
| Supporting context | Bounded local UTF-8 logs, JSON/JSONL, Markdown, text and YAML; live semantic analysis plus deterministic extraction |
| Test implementation | Contract-derived baseline plus AI-authored requests, response assertions, workflows and captures |
| Maintenance | Context watching, serialized runs, validated-plan reuse, durable semantic obligations and reviewed replacement mappings |
| Acceptance | Execution, integrity, operation/scenario linkage, semantic proof references and isolation gates |
| Repair | Request changes, inserted setup, added tests/workflows and assertions; workflow cleanup runs after failures |
| Reports | Consolidated Markdown/JSON, context changes, coverage backlog, attempts, repairs, model usage and Playwright evidence |
| Not yet supported | Swagger 2 conversion, WSDL/SOAP, PDF/DOCX extraction, structured Gherkin, requirements-only execution, arbitrary code/capture/order repairs |

Adding an extension to an allowlist does not implement a format adapter. See [the current objective audit](docs/agentic-objectives-audit.md) and [remaining work](docs/implementation-plan.md).

## Commands and evidence

```bash
npm run gauntlet -- discover          # model analysis; no target requests
npm run gauntlet -- generate          # model-authored plan; no target requests
npm run gauntlet -- run               # complete one-shot loop
npm run gauntlet -- run --watch       # complete loop plus context monitoring
npm run gauntlet -- report <run-id>   # saved result.json
```

All commands accept `--config path/to/gauntlet.config.json`. Discovery is the `discover` subcommand, not `--discover`. A live generation is a separate model invocation; a later run generates again and can produce a different plan.

Each run prints the path to `analysis.md`. Its directory also contains `analysis.json`, `context.json`, `scenario-ledger.json`, and, for live runs, `coverage-backlog.json`. The [agentic guide](docs/agentic-loop.md#evidence) explains the detailed artifacts.

Watch mode prints each run's status and keeps monitoring; its process exit is not a per-run CI verdict. Use one-shot `run` for exit codes: `0` passed, `1` failed, `2` blocked/stalled, `3` setup/runtime error.

## Offline training and validation

These commands use deterministic fixtures or scripted model test servers, with real loopback HTTP and no paid model calls:

```bash
npm run demo
npm run course:example
npm test
npm run typecheck
```

For deterministic discovery, explicitly select `gauntlet.offline.config.json`. The root configuration is live. Clear exported `GAUNTLET_AGENT_PROVIDER`, `GAUNTLET_AGENT_MODEL`, and `GAUNTLET_BASE_URL` overrides before offline exercises so they use their intended configuration. Playwright API testing requires no browser binary.

Optional checks using actual model calls and disposable local APIs:

```bash
npm run maintenance:verify   # health API: initial run, reuse, changed requirement
npm run agentic:verify      # broader sample API; may expose unresolved coverage gaps
```

See [validation scope and recorded evidence](docs/validation.md). These checks do not test production services.

## Documentation

- [Documentation map](docs/README.md)
- [Live agent loop and repair boundaries](docs/agentic-loop.md)
- [Configuration and target setup](docs/configuration.md)
- [Architecture](docs/architecture.md)
- [Offline crash course](training/README.md) and [command/configuration reference](training/reference.md)
- [The Witness example](examples/the-witness/README.md) and its separately gated [production walkthrough](training/walkthroughs/05-the-witness-live-production.md)
- [Attribution](NOTICE.md)
