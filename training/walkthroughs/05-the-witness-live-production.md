# Walkthrough 5: The Witness live production journey

This walkthrough lets you prove three different layers yourself, in order:

1. an OpenAI-assisted, GET-only production preflight;
2. a safe authenticated journey that creates and archives disposable records;
3. a full journey that contacts configured lookup providers, runs analysis, and sends real report email.

The three layers are intentionally separate. A healthy endpoint is not proof that
authentication, persistence, workers, providers, analysis, and delivery all work.

## Before you start

Run every command from the repository root. You need Node.js 20+, installed
dependencies, an OpenAI API key for the preflight, and a dedicated The Witness
test account. Do not use credentials you reuse elsewhere.

The live Playwright journey has two confirmation gates:

| Mode | It may do | It deliberately does not do | Required confirmation |
|---|---|---|---|
| `safe` | sign up or log in, create/update/archive a case | create lookups, contact lookup providers, run analysis, send email | `I_AUTHORIZE_DISPOSABLE_RECORDS` |
| `full` | everything in safe mode plus an authorized lookup, case analysis, and two report emails | delete the retained audit records | `I_AUTHORIZE_FULL_EXTERNAL_ACTIONS` |

The API exposes no account, case, or lookup deletion route in the source-derived
contract. The walkthrough archives its case and revokes its session, but the test
account, archived case, lookup, and reports remain in production.

## Step 1: install and check the framework

```bash
npm ci
npm test
```

Expected: the framework test command exits `0` with no failed Node tests. Stop if
it fails; a broken local runner makes live evidence ambiguous.

## Step 2: run the local self-healing proof first

Enter the OpenAI key without placing it directly in shell history:

```bash
read -s "OPENAI_API_KEY?OpenAI API key: "
export OPENAI_API_KEY
echo
npm run witness:demo
```

Expected: the first injected attempt fails because generated test data was made
stale, the bounded healer restores only signed generated files, and the next
attempt passes. The final JSON should report `status: PASSED`, `iterations: 2`,
`score: 100`, and `tests: 27`.

Copy the printed `runDir`; inspect `result.json`, `attempts/1/heal.json`,
`attempts/1/heal-1.diff`, and the final `critic.json`. This is the OpenAI
identification/critique plus deterministic Playwright generation and self-heal
proof, against the no-egress local fixture.

## Step 3: validate the live preflight without calling production

```bash
npm run gauntlet -- doctor --config examples/the-witness/live/gauntlet.safe.config.json
npm run gauntlet -- generate --config examples/the-witness/live/gauntlet.safe.config.json
```

Expected: `doctor` accepts the production opt-in, exact hostname allowlist,
GET-only method allowlist, and OpenAPI document. `generate` produces a small plan
for `/health`, `/ready`, and `/v1/auth/oauth/providers` without making an HTTP
request to production.

Review the plan before authorizing traffic:

```bash
sed -n '1,240p' examples/the-witness/live/.gauntlet/generated/plan.generated.json
```

Expected: every operation uses `GET`; there must be no signup, login, lookup,
case, analysis, email, or OAuth-start request. Stop if any mutating request appears.

## Step 4: run the OpenAI-assisted live preflight

```bash
npm run witness:live:preflight
```

Expected: real requests to the three read-only production operations pass,
operation coverage is `1`, and the terminal result is `PASSED`. Because
`--inject-stale-data` is enabled, expect a bounded generated-data repair and no
application or contract edit. Save the printed `runDir`.

Useful evidence:

```bash
sed -n '1,240p' "<runDir>/result.json"
sed -n '1,240p' "<runDir>/agents/builder.json"
sed -n '1,240p' "<runDir>/attempts/1/heal.json"
```

Replace `<runDir>` with the path printed by the command. No production record or
provider request is permitted by this profile.

## Step 5: prepare a dedicated live account

Choose an email address you control and a unique password of at least 12
characters. If this is the account's first run, set signup to `true`; later runs
can set it to `false`. The test falls back to login if the signup email already
exists.

```bash
read "WITNESS_E2E_EMAIL?Dedicated test email: "
read -s "WITNESS_E2E_PASSWORD?Unique test password: "
export WITNESS_E2E_EMAIL WITNESS_E2E_PASSWORD
echo
export WITNESS_E2E_DISPLAY_NAME="Gauntlet Operator"
export WITNESS_E2E_SIGNUP=true
```

Expected: these commands print no password. They change only the current shell
environment and do not write secrets to a repository file.

## Step 6: run the safe authenticated journey

```bash
export WITNESS_LIVE_CONFIRM=I_AUTHORIZE_DISPOSABLE_RECORDS
npm run witness:live:safe
```

Expected Playwright result:

```text
5 passed
2 skipped
```

The passing checks prove:

- `/health` is healthy and `/ready` reports database and Redis `up`;
- an unauthenticated session request is rejected with `401`;
- signup/login returns a bearer session and the authenticated session matches your email;
- a case can be created, updated, read, listed, and finally archived;
- logout revokes the test session.

The two skipped tests are the lookup-provider and analysis/email tests. If they
run in safe mode, stop: the mode gate is not working as designed.

On failure, open the retained trace/report locally:

```bash
npx playwright show-report examples/the-witness/live/.gauntlet/playwright-report
```

## Step 7: choose an authorized full-run target

Only continue with a value you own, are testing on yourself, or are explicitly
authorized to investigate. The value is sent to every lookup provider configured
for that lookup type. Do not use an unrelated person's email, phone, username,
image, VIN, domain, IP address, or business.

Example for a domain you control:

```bash
export WITNESS_E2E_LOOKUP_TYPE=domain
read "WITNESS_E2E_LOOKUP_VALUE?Domain you own and authorize: "
export WITNESS_E2E_LOOKUP_VALUE
export WITNESS_E2E_LOOKUP_PURPOSE=self_check
```

Expected: no network request occurs yet. The test refuses full mode if either the
type or value is missing.

## Step 8: run the full customer journey

This step performs real external actions. It can consume provider/OpenAI/email
quota and sends two messages to `WITNESS_E2E_EMAIL`.

```bash
export WITNESS_LIVE_CONFIRM=I_AUTHORIZE_FULL_EXTERNAL_ACTIONS
npm run witness:live:full
```

Expected Playwright result:

```text
7 passed
```

The additional checks prove the production API and worker can:

1. accept an explicitly authorized lookup with `202 queued`;
2. move it through the worker pipeline to `complete` or `partial` with evidence;
3. attach it to the disposable case;
4. queue and persist a newer cumulative analysis report;
5. have the email provider accept both lookup and case report delivery;
6. archive the case and revoke the session.

Confirm both report messages arrive in the inbox. An API `200 delivered: true`
proves provider acceptance, while inbox receipt proves the final user-visible
boundary. Check spam/junk before declaring delivery broken.

## Step 9: interpret failures without self-healing the product

| Failure | Meaning | Next check |
|---|---|---|
| `/ready` is `503` | database or Redis is unavailable | response `checks`, then Render API/Redis logs |
| signup/login is `4xx` | credentials, validation, or account state failed | response in trace; retry with signup disabled if the account exists |
| lookup stays queued | worker is not consuming jobs | Render worker status and logs |
| lookup ends `partial` with a report and evidence | at least one public source was unavailable, but the product produced a usable report | continue; inspect `limitations` to see the coverage gap |
| lookup ends `failed` or `blocked` | provider execution or policy produced no usable report | retained trace plus worker/provider logs |
| analysis never creates a new version | analysis worker/provider failed | worker logs and case detail response |
| email is `409` | a complete report was not ready | lookup/case report state |
| email is `502` or `503` | delivery provider/configuration failed | API logs and email-provider configuration |
| API says delivered but inbox is empty | acceptance did not become receipt | spam/junk, suppression/bounce records, provider delivery log |

The Gauntlet healer repairs only generated-test drift. It must not change the
production API, weaken an assertion, or reinterpret a real product failure as a
pass. The full journey is deliberately hand-written because its asynchronous
worker polling and irreversible external actions require explicit human review.

## Step 10: clear secrets from the shell

```bash
unset OPENAI_API_KEY
unset WITNESS_E2E_EMAIL WITNESS_E2E_PASSWORD WITNESS_E2E_DISPLAY_NAME
unset WITNESS_E2E_SIGNUP WITNESS_E2E_LOOKUP_TYPE WITNESS_E2E_LOOKUP_VALUE
unset WITNESS_E2E_LOOKUP_PURPOSE WITNESS_LIVE_CONFIRM
```

Expected: the following command prints nothing:

```bash
env | grep -E '^(OPENAI_API_KEY|WITNESS_E2E_|WITNESS_LIVE_CONFIRM)='
```

This does not delete the production records described above.
