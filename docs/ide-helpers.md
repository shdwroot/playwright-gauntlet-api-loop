# Project helpers for Codex, Claude Code and GitHub Copilot

Two helpers are available in each assistant:

| Helper | Input | Output |
| --- | --- | --- |
| `gauntlet-api-analysis` | Your API contract, requirements and optional config | `api-analysis.md`, `requirements-matrix.json`, onboarding gaps and next command |
| `gauntlet-failure-analysis` | A selected run directory and optional config | `developer-analysis.md`, evidence-backed findings, reproduction prerequisites and regression checks |

Open the Gauntlet repository as the workspace. These are IDE analysis helpers: they use your assistant's selected model. The Gauntlet runtime separately uses its configured OpenAI or Azure provider. Invoking a helper does not start a background loop, replay API mutations or change application source. Existing user authorization still applies when you request subsequent execution or repairs.

## Codex

Select the skill by typing `$`, or invoke it directly:

```text
$gauntlet-api-analysis Analyze <OpenAPI URL> and <requirement paths>. Prepare a local config and per-criterion coverage matrix; validate with doctor without executing target tests.
```

```text
$gauntlet-failure-analysis Analyze <run directory> using <config path>. Explain failures and unverified criteria and write the developer handoff.
```

The shared skills live in `.agents/skills/`. See [Codex skills](https://developers.openai.com/codex/skills/) for discovery behavior.

## Claude Code

Invoke a native skill:

```text
/gauntlet-api-analysis Analyze <OpenAPI URL> and <requirement paths>. Prepare the onboarding report without executing target tests.
```

```text
/gauntlet-failure-analysis Analyze <run directory> using <config path>. Write the developer handoff from saved evidence.
```

Or explicitly delegate to a named project agent:

```text
Use the gauntlet-api-analysis agent to analyze <OpenAPI URL> and <requirement paths>.
Use the gauntlet-failure-analysis agent to investigate <run directory>.
```

Native entries live in `.claude/skills/` and `.claude/agents/`. Restart Claude Code if a newly created helper directory is not discovered. The adapters read the shared workflow rather than maintaining a separate procedure. See [Claude skills](https://code.claude.com/docs/en/skills) and [subagents](https://code.claude.com/docs/en/sub-agents).

## GitHub Copilot

In Copilot Chat in a supported IDE, open the agent dropdown and select `gauntlet-api-analysis` or `gauntlet-failure-analysis`. Then supply the corresponding prompt above without the Codex `$` prefix.

Custom agents live in `.github/agents/*.agent.md`. Copilot also supports project skills in `.agents/skills/`, so the shared skills are available for relevant analysis tasks without another copied skill library. Claude's thin wrappers have the same names and resolve to the same shared workflow if that skill location takes precedence in your client. See [Copilot custom agents in IDEs](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/create-custom-agents-in-your-ide) and [agent skills](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills).

Copilot CLI can select the same custom agents when started in this checkout:

```bash
copilot --agent gauntlet-api-analysis
copilot --agent gauntlet-failure-analysis
```

Then provide your API or run details in the interactive session. `/agent` lists available agents and `/skills list` lists skills in the installed CLI.

If entries are missing, reload the workspace and check that your client supports custom agents/skills and that organization settings allow them. A cloud agent cannot access an API on your workstation's loopback address or untracked `.gauntlet/` evidence; use a local IDE session for those inputs. Do not upload private target context simply to make a cloud helper work.

## Maintaining the helpers

Edit `.agents/skills/gauntlet-api-analysis/SKILL.md` or `.agents/skills/gauntlet-failure-analysis/SKILL.md` for shared behavior. Claude skills and both assistants' agent profiles route to those files. Keep names, descriptions and reference paths aligned when renaming a helper. Avoid hardcoded sample-API routes, model names, credentials or run directories.

Keep reports under the selected ignored `.gauntlet/<project>/` directory or the user's chosen output directory. Helper availability is not evidence of a completed API test: reports must distinguish observed failures, hypotheses, framework limitations and unverified coverage.

Validation in this checkout: all four skill entry points passed the skill validator, the four native agent profiles had valid YAML and resolvable shared-workflow links, and `claude agents --setting-sources project` listed both project agents with inherited models. Copilot profile paths were checked against its documented format and installed CLI options; VS Code discovery and end-to-end helper output have not been exercised. No target or LLM calls were made for these checks.
