# URL onboarding and API source repair

The URL entry point imports the live OpenAPI contract, copies supplied context, configures all declared HTTP methods, and starts the live agent loop with one command:

```bash
npm run gauntlet -- run --url http://127.0.0.1:8080/openapi.json --context ./your-api/requirements.json
```

Replace the URL and context path with your own API inputs. Testing does not require access to the application source. Add `--watch` for continuous context maintenance and, separately, `--source auto` when you want source repair in a supported local deployment.

The core loop owns contract/context ingestion, discovery, test compilation, execution, coverage, healing and reports. Application-specific provisioning, database access and restart commands belong to optional integrations. The RESTaurant integration below is a sample adapter, not a requirement for onboarding another API. Arbitrary fixture adapters are not yet configurable through the built-in fixture interface; other APIs can use declared setup/cleanup workflows and reset hooks.

The repository `.env` is loaded before onboarding. The explicit URL wins over an unrelated `GAUNTLET_BASE_URL`. Luna is the default; `--model` selects another model. No offline provider is substituted when a model call fails.

Supply `--context` repeatedly for additional files or directories. A plain API base URL is also accepted; onboarding looks for `openapi.json` beneath that base. A custom contract filename ending in JSON or YAML is treated as a spec URL with its containing URL as the API base. The contract's `servers` value is not followed automatically. Remote targets require `--allow-production`.

Projects are stored under `.gauntlet/projects/<target-hash>/`, or `--project-dir <directory>`. Repeating onboarding refreshes the contract and selected context while preserving configured credentials, quality gates, budgets and repair settings. Inspect `onboarding.json` for source hashes and original context paths. With `--watch`, original context files and directory contents participate in revision detection; the next run reimports them and refreshes the contract. Changes during execution invalidate that run's context snapshot and schedule a fresh cycle.

Completed runs retain their compiled candidate plan even when tests fail. A rerun with unchanged context supplies that plan to the builder so it can continue existing work. Candidate checkpoints are hash-checked and never treated as a previous pass: discovery, execution and verification still run. Changed context invalidates checkpoint reuse. The final command output includes blocker explanations, verified/outstanding obligation counts and the report path.

`doctor --url ...` imports and validates without model or test execution. `run --url ...` performs discovery, generation, execution, verification and bounded healing. It permits declared mutations against the selected environment; use a disposable test API. GET-only restrictions are not inserted by onboarding.

## Authentication

Form-encoded request schemas are imported alongside JSON schemas. Generated plans preserve their encoding, and Playwright sends form bodies appropriately. Agents can register a disposable account with a synthetic run-specific password, obtain an access token, and reference that token within a workflow. Runtime tokens are not written into generated test source or model inputs. Static credentials can still be mapped through `headersFromEnv`.

When `--source auto` recognizes the RESTaurant SQLAlchemy application, it also configures the included fixture adapter. Before each case or workflow it provisions independent Customer A/B, Employee and Chef accounts, a pagination customer with 101 orders, an expired-reset customer, two menu items and an A-owned order. It supplies symbolic credential/ID bindings and cleans namespace-owned records in `finally`. It never resets the shared database or obtains staff privileges through an API vulnerability. Tokens are obtained through the running API login endpoint, so they use the same signing key as the server. Login requests count toward the request budget. Runtime credential values are not sent to models.

A separate pagination customer owns 101 orders so the agent can test the documented default limit of 100 and explicit pagination against a known dataset. Customer A retains one order and Customer B starts with none. All of these records share the same per-test cleanup namespace.

This adapter is specific to the recognized RESTaurant schema. Other APIs need their own fixture integration. The adapter supports namespace-scoped database observations after a request: order/item/coupon counts, credential preservation and reset-code format/expiry. Counts are numbers, so assertions use `equals`, `gte` or `lte`. It also provides a controlled PNG endpoint and a forbidden internal sentinel with request counters for image-fetch tests. Bounded concurrent workflow groups support race tests and combined success counts; general clock control, delivery-adapter simulation and global SQL instrumentation remain unsupported; fixture capabilities alone do not prove their criteria.

## API source repair

`--source auto` identifies one Docker Compose service bound to the selected loopback port and locates its checkout. The initial automatic adapter supports Python projects with `pyproject.toml` and an `app/` directory. `--source /checkout/path` additionally checks that the discovered service belongs to that checkout. Ambiguous or unsupported deployments require an explicit `sourceRepair` configuration:

```json
{
  "sourceRepair": {
    "root": "/path/to/api-checkout",
    "include": ["app"],
    "verifyCommand": ["python3", "-m", "compileall", "-q", "app"],
    "restartCommand": ["docker", "compose", "up", "--build", "--no-deps", "-d", "--wait", "web"],
    "maxAttempts": 4,
    "commandTimeoutMs": 300000
  }
}
```

Commands are configured argument arrays, executed without a shell; they are not supplied by the model. The automatic Python verifier checks syntax. Configure application regression tests as the verifier when available. The unchanged Playwright plan is rerun against the restarted API to establish whether the observed defect was fixed.

The recognized local RESTaurant adapter rebuilds a source layer on top of its existing application image and recreates the service with Compose. This source-only path keeps installed dependencies and avoids registry credentials/downloads. It uses Docker's legacy local builder with an isolated credential-free CLI configuration; Docker installations without that builder need an explicit restart command. Dependency or Dockerfile changes require a normal application rebuild. Deployment records retain the before/after image IDs, and the adapter checks that the running container uses the built image. Other Python deployments use the configured full Compose rebuild.

After the healer classifies an evidenced product defect, the developer role proposes exact source replacements. Edits are restricted to the supplied implementation files; test files, hidden files, migrations, configuration/credential files and symlinks are excluded. Multiple nonoverlapping edits to a file are supported. Concurrent changes, overlapping edits and non-unique anchors are rejected before any source write. Failed verification or restart restores the original source and attempts to restart it. The original files, proposed changes, hashes, command outcomes and subsequent test results remain in the local run artifacts.

Source repair does not weaken response assertions or silently change the downloaded oracle. Missing credentials, unimplemented fixtures and conflicting requirements are not application defects to patch away. A patched API can still fail its rerun; the report retains both attempts and never equates a successful rebuild with a passing test.

For generated-test implementation errors, the healer can correct an invalid numeric comparison on a root response array to the matching array-length comparison. The original bound, response contract and provenance remain fixed; valid numeric comparisons cannot use this repair. New malformed array comparisons are rejected before execution. The proposal and repaired plan record the correction for review.

Explicit structured criteria can supplement the test contract with missing routes and stated response codes. `requirement-oracles.json` records their separate provenance. Existing OpenAPI responses and schemas are preserved. The runtime can assert response-field presence/absence and response headers as well as body values; this enables disclosure checks without treating a generic 200 as proof of security.

## Coverage accounting and current validation

Structured requirement documents with `requirements[].id`, `acceptance_criteria`, and `endpoints` receive a deterministic per-criterion census. Every criterion remains an obligation for model implementation and fresh semantic verification, including criteria missing from a short discovery response. Additional model-discovered scenarios remain separate obligations. General prose still requires model discovery.

The onboarding/auth transport, requirement-oracle provenance and source patch/rollback paths have automated regression tests. The RESTaurant fixture adapter has been checked against the live API: all four actor profiles authenticated with their intended roles, followed by scoped cleanup. A live Luna developer call repaired pagination validation, rebuilt/restarted the API, and the unchanged invalid-bound tests then passed. The same rerun also exposed malformed generated array comparisons, now covered by narrow assertion-repair support. Full RESTaurant acceptance remains under validation; the source-fix evidence does not establish that the entire requirement set passes.
