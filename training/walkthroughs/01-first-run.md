# Walkthrough 1: run the inventory gauntlet by hand

You will start the training API yourself, validate its contract, generate its test plan, execute the plan, and inspect the passing result. This exposes every command hidden behind `npm run course:example`.

## What you need

- Node.js 20 or newer
- `npm ci` completed in the repository root
- Two terminal windows

## Step 1: Start the system under test

In terminal A:

```bash
export TRAINING_API_KEY=training-local-key
node training/example-project/inventory-api.mjs
```

Expected output:

```text
Training inventory API listening on http://127.0.0.1:4020
```

This process is the application being tested. Leave it running through Step 6.

## Step 2: Ask the doctor to validate the inputs

In terminal B:

```bash
npm run gauntlet -- doctor --config training/example-project/gauntlet.config.json
```

The command should report `"ok": true`, `"operations": 5`, and `"workflows": 1`. Doctor loads and validates the config and OpenAPI document but sends no request to the API.

## Step 3: Generate the candidate

```bash
npm run gauntlet -- generate --config training/example-project/gauntlet.config.json
```

Expected counts:

```json
{
  "cases": 12,
  "workflows": 1
}
```

The generated files now live under `training/example-project/.gauntlet/generated/`:

- `plan.generated.json`: typed requests, expectations, rationale, source pointers, and coverage
- `api.generated.spec.mjs`: a small renderer that executes every planned case
- `manifest.json`: hashes tying the plan and rendered test to this contract and seed

## Step 4: Review what will run

Print a compact case list without requiring `jq`:

```bash
node -e "const p=require('./training/example-project/.gauntlet/generated/plan.generated.json'); console.table(p.cases.map(c=>({kind:c.kind,method:c.method,path:c.path,expected:c.expected.statuses.join(',')}))); console.table(p.workflows.map(w=>({workflow:w.id,steps:w.steps.length})))"
```

Before using another target, check at least these fields:

- `operations[*].coveredBy`: every required operation should have coverage.
- `cases[*].method` and `cases[*].path`: no unexpected mutation or route.
- `cases[*].body`, `query`, and `pathParams`: generated inputs match the target environment.
- `cases[*].expected`: statuses and schemas came from the intended contract.
- `workflows[*].steps`: captured identifiers flow only into intended later requests.

## Step 5: Execute and critique

Export the credential in terminal B and run the loop:

```bash
export TRAINING_API_KEY=training-local-key
npm run gauntlet -- run --config training/example-project/gauntlet.config.json
```

Expected terminal fields:

```json
{
  "status": "PASSED",
  "iterations": 1,
  "score": 100,
  "hardFindings": []
}
```

Copy the printed `runId` and `runDir` for the next step.

## Step 6: Read the evidence

Print the saved terminal result using the run ID:

```bash
npm run gauntlet -- report <run-id> --config training/example-project/gauntlet.config.json
```

Then inspect these files inside the printed run directory:

1. `events.json`: ordered `DISCOVER → PLAN → GENERATE → EXECUTE → CRITIQUE → PASSED` transitions.
2. `attempts/1/execution.json`: 13 Playwright tests, their pass/fail counts, duration, and report paths.
3. `attempts/1/critic.json`: score components, findings, hard failures, and critic identity.
4. `attempts/1/html/index.html`: browsable Playwright report.
5. `result.json`: final status, findings, events, and any heal decisions.

The 13 Playwright tests are 12 standalone cases plus one workflow test. The workflow itself makes three HTTP requests.

## Step 7: Stop the API

Return to terminal A and press `Ctrl-C`. The fixture closes its server and exits.

## What you built

You ran the framework as an operator rather than treating it as a black box. You validated before execution, reviewed the candidate, captured a real HTTP result, and traced the terminal verdict back to raw evidence.

Next: [Walkthrough 2: evidence and safe healing](02-evidence-and-healing.md).

## Troubleshooting

### `CREDENTIAL_MISSING: TRAINING_API_KEY`

The config names the environment variable but never loads `.env` automatically. Export it in the same terminal that runs the gauntlet:

```bash
export TRAINING_API_KEY=training-local-key
```

### `TARGET_UNREACHABLE` or `ECONNREFUSED`

Confirm terminal A is still running and listening on port `4020`:

```bash
curl http://127.0.0.1:4020/health
```

### `EADDRINUSE`

Another process already owns port `4020`. Stop the earlier training fixture before starting a new one:

```bash
lsof -nP -iTCP:4020 -sTCP:LISTEN
```

### `TARGET_DENIED`

The config's `baseUrl` hostname and `safety.allowedHosts` do not match exactly. Keep this tutorial on `127.0.0.1`; do not enable production access to solve a local typo.
