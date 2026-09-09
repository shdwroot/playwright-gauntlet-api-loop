# Discover API scenarios from logs and documents

This walkthrough adds operational context without handing authority to that context. You will inspect the included adversarial corpus, run discovery without contacting an API, trace candidates into the generated plan, and verify the cases against the loopback fixture.

## The authority rule

Keep this sentence in view: **logs and documents explain what may be worth testing; OpenAPI alone defines what the test expects.**

That separation prevents three dangerous shortcuts:

- an observed `500` becoming the new expected `500`;
- a support note inventing and calling an undocumented admin endpoint;
- source text such as “ignore the contract” changing an agent’s instructions.

The discovery router extracts bounded method/path/status signals, applies deterministic policy, and passes only typed decisions to planning.

## Step 1: Inspect the sample corpus

Open [`../../context/sample-system.log`](../../context/sample-system.log). It includes exact log signals for malformed JSON, unsupported media type, a query boundary, a not-found request, an unexpected `500`, and an undocumented route. Its last line deliberately contains a bearer token, email, and customer identifier to test redaction.

Open [`../../context/scenario-guidance.md`](../../context/scenario-guidance.md). It includes whitespace validation, missing-auth, conflict, oversized-payload, and undocumented-route notes, plus a deliberate prompt-injection sentence.

Good machine-readable evidence names the HTTP method, literal request path, observed status, and symptom on one line:

```text
2030-01-02T03:04:05Z requestId=r1 method=POST path=/users status=400 error="malformed JSON"
```

Avoid vague prose such as “users sometimes fail.” It cannot identify an operation or reproducible input accurately and should remain report-only.

## Step 2: Inspect the discovery budget

The root [`../../gauntlet.config.json`](../../gauntlet.config.json) enables two sources and sets file, byte, candidate, per-operation, excerpt, and confidence limits. Paths are resolved relative to that config. Every source must remain inside the same project root.

The sample sets `required: true`, so deleting or renaming a source fails rather than silently reducing coverage. In a gradual rollout, use `required: false`; an empty corpus then produces an explicit warning and a contract-only plan.

## Step 3: Run discovery without network execution

```bash
npm run gauntlet -- discover
```

This command reads the OpenAPI file and configured local sources only. Search the JSON output for:

```text
"disposition": "generate"
"disposition": "merge"
"disposition": "report-only"
UNTRUSTED_INSTRUCTION_TEXT
[REDACTED_TOKEN]
[REDACTED_EMAIL]
[REDACTED_ID]
```

Verify the raw token, email, and customer ID do not appear. Each candidate includes a stable ID, signal, confidence, operation mapping, OpenAPI pointers, source hash, relative path, exact line range, and redacted excerpt.

Expected sample decisions:

| Signal | Decision | Why |
|---|---|---|
| malformed JSON `POST /users -> 400` | `generate` | Exact operation and declared `400`; raw invalid bytes are synthetic. |
| `text/plain POST /users -> 415` | `generate` | Exact operation and declared `415`; body is synthetic. |
| `GET /users?limit=0 -> 400` | `generate`, then possibly `merge` | Invalid value is recomputed from OpenAPI bounds. |
| whitespace-only name `-> 422` | `generate` | Required string constraint and `422` are contract-backed. |
| missing auth, not found, duplicate | `merge` | Baseline planner already owns equivalent negative cases. |
| oversized payload `-> 413` | `report-only` | Replaying a huge body is outside v1 automatic policy. |
| observed `500` | `report-only` | `500` is absent from the contract and cannot become expected. |
| `/internal/diagnostics` or `/admin/restart` | `report-only` | No exact OpenAPI operation exists. |
| prompt-injection sentence | source warning | It is tainted text, not an instruction or scenario. |

## Step 4: Generate and trace the plan

```bash
npm run gauntlet -- generate
```

Open `.gauntlet/generated/plan.generated.json`. For every case whose `kind` is `discovered`, verify:

1. `discovery.candidateIds` links back to the discovery decision.
2. `discovery.evidence` contains only source-relative, hashed, redacted citations.
3. `oracleProvenance.authority` is `openapi`.
4. `oracleProvenance.specHash` equals the plan’s `specHash`.
5. Expected statuses and schemas correspond to the listed OpenAPI pointers.
6. No observed credential, identifier, email, or request body was replayed.

The manifest’s `discoveryHash` signs the final decisions. Reversing source order produces the same semantic candidates and test bytes. Editing source content intentionally changes the source and discovery hashes.

## Step 5: Execute the evidence-backed cases

Terminal 1:

```bash
npm run fixture
```

Terminal 2:

```bash
export SAMPLE_API_KEY=gauntlet-local-key
npm run gauntlet -- run
```

A clean sample run executes 20 standalone cases plus one workflow test and reaches `PASSED` with score `100`. The run directory contains `discovery/report.json`, the signed plan and generated manifest, Playwright JSON/JUnit/HTML evidence, redacted exchanges, critic findings, and the terminal result.

## Step 6: Audit drift and failure behavior

Before acceptance, the critic re-hashes each source. If a file changed after planning, acceptance fails with `SOURCE_CHANGED`; if it disappeared, `SOURCE_MISSING`. The critic also blocks missing citations, unmatched executable operations, discovery hash drift, credential leakage, or missing OpenAPI oracle provenance.

If a discovered regression fails at runtime, the healer may restore a corrupted generated artifact from the same signed plan. It cannot remove the discovery citation, accept an observed failure status, edit the source, weaken an assertion, or promote a report-only candidate.

## Bring your own corpus checklist

- [ ] Use a disposable/local target before enabling mutations.
- [ ] Prefer structured one-line events with method, path, status, correlation ID, and symptom.
- [ ] Keep only reviewed text exports; do not feed raw PDF/DOCX, archives, binaries, or remote URLs.
- [ ] Set tight root, extension, file-count, byte, candidate, per-operation, excerpt, and request budgets.
- [ ] Scan redacted output for credential and PII leaks.
- [ ] Review every source warning and candidate disposition.
- [ ] Fix or document contract gaps; do not fuzzy-map them.
- [ ] Confirm every executable expectation cites OpenAPI.
- [ ] Keep destructive and production access disabled unless independently authorized.
- [ ] Store the discovery report, plan, manifest, critic result, and Playwright evidence together for audit.

## Troubleshooting

`DISCOVERY_SOURCE_MISSING` means a configured file or directory does not exist. `DISCOVERY_SYMLINK_REJECTED` and `PATH_OUTSIDE_ALLOWED_ROOT` protect the source boundary. `DISCOVERY_FILE_SIZE_LIMIT`, `DISCOVERY_TOTAL_SIZE_LIMIT`, `DISCOVERY_FILE_LIMIT`, and `DISCOVERY_CANDIDATE_LIMIT` mean the corpus exceeded a declared budget; narrow it rather than silently truncating. `UNSUPPORTED_BINARY_SOURCE` or `DISCOVERY_INVALID_UTF8` means you must export reviewed UTF-8 text first.

Next, use the [framework reference](../reference.md#discovery) for exact settings and the [architecture guide](../../docs/architecture.md#trust-boundaries) for the critic and healing boundaries.
