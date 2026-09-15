# Editable runtime prompts

Edit these Markdown files to change Gauntlet's LLM instructions. They are loaded from disk when each role is invoked; no TypeScript edit, build or process restart is needed for prompt-text changes. Both OpenAI and Azure use these files.

| File | Role |
| --- | --- |
| [discovery.md](discovery.md) | Analyze contracts and context; propose semantic scenarios |
| [lead.md](lead.md) | Choose the next build, execute, heal, accept or block action |
| [builder.md](builder.md) | Author tests and workflows |
| [verifier.md](verifier.md) | Review semantic coverage and isolation proofs |
| [critic.md](critic.md) | Review execution evidence against configured gates |
| [healer.md](healer.md) | Diagnose failures and propose permitted test repairs |
| [developer.md](developer.md) | Propose scoped API source repairs when configured |
| [plan-protocol.md](plan-protocol.md) | Shared test-authoring and repair instructions |
| [transport.md](transport.md) | Shared trust/evidence rules and output-format instructions appended to every live invocation |

Builder and healer include the shared protocol with `{{plan_protocol}}`. That is the only supported include, and nested includes are rejected. Capture placeholders such as `${runId}` and `${accessToken}` are preserved literally for the test compiler. Prompt contents are text, never executable JavaScript, shell commands or environment interpolation.

For example, add a discovery instruction describing which semantic boundaries deserve more attention, save `discovery.md`, and use your existing `discover` or `run` command. A running `--watch` loop detects the changed prompt hash and schedules a new cycle. Those commands make live model calls; `run` also executes target tests under the configured scope. Editing a file alone does not start a stopped Gauntlet process.

Prompt hashes participate in the context revision for live runs. Changes invalidate previously compiled candidate reuse. If a prompt changes during a run, that result cannot certify the new revision and is marked blocked; watch mode schedules a fresh cycle after the current run. Keep edits stable while validating a run. Missing, empty, oversized or invalid-include prompt files fail explicitly; there is no hidden embedded fallback. Individual files are limited to 256 KiB. The runtime resolves this folder relative to its installation, not the target config or current working directory. Keep `prompts/` alongside `src/` and `dist/` when distributing the framework.

Each audited call saves the role `system`, `transportInstructions` and combined `effectiveInstructions` in `<run-directory>/agents/calls/<sequence>-<role>-input.json`, subject to redaction. These are the assembled instructions used for that call. The provider's `promptHash` covers the model, assembled instructions, sanitized input and structured output schema. Context evidence lists prompt source hashes as `framework-prompts/<name>.md`.

Output JSON schemas, plan validation, request budgets, contract assertions and acceptance gates remain in TypeScript. Changing prose cannot add an unsupported schema field or bypass these checks. Runtime inputs such as the selected contract, coverage backlog, fixture capabilities and failure evidence are still assembled by code; they are context supplied to the editable prompts, not additional system-prompt files.

IDE helpers are already external files. Their shared workflows remain in [.agents/skills](../.agents/skills/), with Claude Code and Copilot adapters in their native discovery folders. Edit those workflows for IDE-helper behavior; edit this folder for Gauntlet's runtime agents. See the [IDE helper guide](../docs/ide-helpers.md).

## Role responsibilities and evaluation

Every role receives the shared trust, evidence and capability rules in `transport.md`. Discovery separates supported expectations from inferred hypotheses and missing observability. Builder prioritizes the coverage worklist and meaningful assertions. Verifier checks complete behavior against its per-obligation proof catalog. Critic preserves deterministic blocking authority. Healer classifies failure ownership before permitted test repairs; developer proposes scoped implementation patches only when the runtime enables source repair. Lead selects an allowed next action and requires fresh evidence before acceptance.

`plan-protocol.md` describes decoded plan semantics. The role output schema and `transport.md` define the actual JSON envelope, including typed request maps, `scenarioJson` and keyed verifier assessments. Keep both layers aligned when editing examples. Detailed framework constraints belong here; API-specific business rules belong in onboarding context.

Use the [prompt evaluation cases](evaluation.md) to compare behavior before and after changes. Existing automated tests cover prompt loading, audit transport, context invalidation and deterministic enforcement; they do not measure how well a live model follows a rewritten instruction. The current revision passed those checks without a new paid-model evaluation. Do not claim improved discovery quality or complete coverage until a controlled live comparison supports it.

Runtime inputs can be bounded slices. `transport.md` explains scope/omission markers and shared `contextSchemas`; `verifier.md` defines semantic, isolation and reconciliation assignments. Prompt edits must preserve these boundaries: unseen evidence stays unknown, and other batches stay pending until reviewed. Budget settings live in the config’s `agents` object; see [configuration](../docs/configuration.md#bounded-agent-context).
