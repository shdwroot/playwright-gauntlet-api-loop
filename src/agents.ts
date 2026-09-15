import { loadPrompt } from './prompts.js';
import { azureResponsesUrl } from './azure.js';
import { fetchAgentResponse } from './provider-http.js';
import { agentOutputSchema, decodeAgentOutput } from './agent-protocol.js';
import type { AgentConfig, CriticFinding, DiscoveryReport, NormalizedContract, TestPlan, GauntletConfig } from './types.js';
import { applyAgentPlan, applyAgentPlanIncrementally, record, string } from './agent-plan.js';
import { redactAgentData } from './agent-redaction.js';
import { buildPlan } from './planner.js';
import { redact, sha256, stableStringify } from './utils.js';
import { bindFixtureDefaults, FIXTURE_BINDINGS, FIXTURE_OBSERVATION_GUIDE } from './fixtures.js';

export type AgentRole = 'lead' | 'discovery' | 'builder' | 'critic' | 'healer' | 'verifier' | 'developer';

export interface AgentReply {
  agentId: string;
  model: string;
  output: unknown;
  promptHash: string;
  responseHash: string;
  durationMs?: number;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface AgentProvider {
  invoke(role: AgentRole, model: string, system: string, input: unknown, transportInstructions?: string): Promise<AgentReply>;
}

export class DeterministicAgentProvider implements AgentProvider {
  async invoke(role: AgentRole, model: string, _system: string, input: unknown): Promise<AgentReply> {
    const prompt = stableStringify(redact(input));
    const output = role === 'builder'
      ? { riskNotes: [], generatedBy: 'deterministic-contract-compiler' }
      : { decision: 'pass', findings: [], evaluatedBy: 'deterministic-evidence-critic' };
    return {
      agentId: `${role}:${model}:${sha256(prompt).slice(0, 12)}`,
      model,
      output,
      promptHash: sha256(prompt),
      responseHash: sha256(stableStringify(output)),
    };
  }
}

export class OpenAIResponsesProvider implements AgentProvider {
  constructor(private readonly config: AgentConfig) {}

  async invoke(role: AgentRole, model: string, system: string, input: unknown, transportInstructions?: string): Promise<AgentReply> {
    const azure = this.config.provider === 'azure';
    const apiKeyEnv = this.config.apiKeyEnv ?? (azure ? 'AZURE_OPENAI_API_KEY' : 'OPENAI_API_KEY');
    const apiKey = process.env[apiKeyEnv];
    if (!apiKey) throw new Error(`CREDENTIAL_MISSING: ${apiKeyEnv}`);
    const baseUrl = (this.config.openaiBaseUrl ?? 'https://api.openai.com').replace(/\/$/, '');
    const sanitized = redactAgentData(input);
    const prompt = stableStringify(sanitized, 0);
    if (prompt.length > 1_000_000) throw new Error(`AGENT_INPUT_LIMIT: ${role} input has ${prompt.length} characters; maximum 1000000`);
    const instructions = `${system}\n${transportInstructions ?? loadPrompt('transport')}`;
    const schema = agentOutputSchema(role, sanitized);
    const promptHash = sha256(stableStringify({ model, instructions, input: sanitized, schema }));
    const started = Date.now();
    console.error(`[${role}] ${model}: calling model`);
    const url = azure ? azureResponsesUrl(this.config.azureEndpoint) : `${baseUrl}/v1/responses`;
    const response = await fetchAgentResponse(url, {
      method: 'POST',
      redirect: 'error',
      headers: { ...(azure ? { 'api-key': apiKey } : { authorization: `Bearer ${apiKey}` }), 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        instructions,
        text: { format: { type: 'json_schema', name: `${role}_response`, strict: true, schema } },
        input: `Return only valid JSON.\n${prompt}`,
      }),
    }, this.config.timeoutMs ?? 120_000, role);
    const responseText = await response.text();
    if (responseText.length > 2_000_000) throw new Error('AGENT_RESPONSE_LIMIT');
    const payload = JSON.parse(responseText) as Record<string, unknown>;
    const direct = typeof payload.output_text === 'string' ? payload.output_text : undefined;
    const nested = Array.isArray(payload.output)
      ? payload.output.flatMap((item) => {
        const record = item as Record<string, unknown>;
        return Array.isArray(record.content) ? record.content.filter(item => item && typeof item === 'object' && (item as Record<string, unknown>).type === 'output_text') : [];
      }).map((item) => (item as Record<string, unknown>).text).find((value) => typeof value === 'string')
      : undefined;
    const text = direct ?? nested;
    if (typeof text !== 'string') throw new Error(`AGENT_OUTPUT_INVALID: ${role} returned no text`);
    let output: unknown;
    let parsed: unknown;
    try { parsed = JSON.parse(text); }
    catch { throw new Error(`AGENT_OUTPUT_INVALID: ${role} returned non-JSON output`); }
    try { output = redactAgentData(decodeAgentOutput(parsed)); }
    catch (error) {
      const detail = error instanceof Error && /^AGENT_OUTPUT_INVALID: [a-zA-Z]+ (?:must encode JSON|contains invalid JSON)$/.test(error.message) ? error.message : 'AGENT_OUTPUT_INVALID: structured output could not be decoded';
      throw new Error(`${detail} (${role}); encode bodyJson/requestJson as valid JSON; use the declared typed request envelope; assertion value is native JSON and captureBindings is a typed array`);
    }
    const usage = payload.usage as Record<string, unknown> | undefined;
    const durationMs = Date.now() - started;
    console.error(`[${role}] ${model}: completed in ${(durationMs / 1000).toFixed(1)}s`);
    return {
      agentId: `${role}:${model}:${promptHash.slice(0, 12)}`, model, output,
      promptHash, responseHash: sha256(stableStringify(output)), durationMs,
      ...(typeof usage?.input_tokens === 'number' && typeof usage?.output_tokens === 'number'
        ? { usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens } } : {}),
    };
  }
}

export function createAgentProvider(config: AgentConfig): AgentProvider {
  switch (config.provider) {
    case 'openai': case 'azure': return new OpenAIResponsesProvider(config);
    case 'deterministic': return new DeterministicAgentProvider();
    default: throw new Error('CONFIG_INVALID: unsupported agent provider');
  }
}

export class BuilderAgent {
  constructor(private readonly provider: AgentProvider) {}

  async build(contract: NormalizedContract, config: GauntletConfig, feedback: CriticFinding[] = [], discovery?: DiscoveryReport, current?: TestPlan): Promise<{ plan: TestPlan; invocation: AgentReply; rejections?: string[] }> {
    const baseline = current ? structuredClone(current) : bindFixtureDefaults(buildPlan(contract, config, discovery), config);
    if (current && discovery) {
      if (baseline.specHash !== contract.specHash) throw new Error('PERSISTED_PLAN_CONTRACT_MISMATCH');
      // Keep existing scenario links while adding newly discovered work. A restored
      // plan is always built, executed and critiqued again; no old pass is reused.
      const candidates = new Map(baseline.discovery?.candidates.map(candidate => [candidate.id, candidate]));
      for (const candidate of discovery.candidates) if (!candidates.has(candidate.id)) candidates.set(candidate.id, candidate);
      const { discoveryHash: _hash, ...unsigned } = { ...discovery, candidates: [...candidates.values()] };
      baseline.discovery = { ...unsigned, discoveryHash: sha256(stableStringify(unsigned)) };
    }
    const invocation = await this.provider.invoke('builder', config.agents.builderModel,
      loadPrompt('builder'),
      { contract: { operations: contract.operations, document: contract.document, workflows: contract.workflows }, currentPlan: { ...baseline, discovery: undefined },
        discovery: compactDiscovery(baseline.discovery ?? discovery), feedback: compactFindings(feedback), isolation: config.isolation,
        coverageWorklist: coverageWorklist(baseline, config.discovery.minimumConfidence),
        fixtures: config.fixtures ? { adapter: config.fixtures.adapter, bindings: FIXTURE_BINDINGS, observations: FIXTURE_OBSERVATION_GUIDE,
          lifecycle: 'Fresh Customer A/B, Employee, Chef, menu item, unreferenced menu item, and Customer A order before each independent case/workflow. They are cleaned afterwards. Use ${customerAToken} etc in bearer headers; ${fixturePassword} is their valid password. ${tamperedSubjectToken} is a copy of A token with subject changed to B without resigning, for SEC-001. ${runId} is the per-test owned namespace. Register new users with username beginning ${runId}- so cleanup owns them. Customer A has an unused 20-percent coupon (${fixtureCouponId}) and a prepared reset code (${fixtureResetCode}). Customer B starts without orders and without reset initiation. A separate paginationCustomer starts with 101 orders: use ${paginationCustomerToken} to test default limit 100, explicit limits and skips; ${paginationOrderCount} is 101. No fixture values are model-visible. Use setupSteps/workflows for scenario-specific state. This is fixture setup, not evidence that the API behavior passes.' } : undefined,
        minimumDiscoveryConfidence: config.discovery.minimumConfidence,
        requestBudget: config.safety.maxRequestsPerRun, maxAgentCasesPerOperation: config.discovery.maxCandidatesPerOperation, safety: config.safety });
    if (config.agents.provider === 'deterministic') return { plan: baseline, invocation };
    return { ...applyAgentPlanIncrementally(baseline, invocation.output, contract, config), invocation };
  }
}

export function compactDiscovery(discovery: DiscoveryReport | undefined) {
  if (!discovery) return undefined;
  // Invocation transcripts duplicate already-normalized candidates and are audit
  // evidence, not another source of requirements for each subsequent role.
  const { analysis: _analysis, ...context } = discovery;
  return context;
}

// Findings embed serialized obligations and complete prior invocations in their
// evidence. Those already exist in discovery/plan; repeating them overflowed the
// builder input after its first execution. Keep diagnostic text and artifact
// references, with explicit omission counts; full evidence stays in the ledger.
export function compactFindings(findings: CriticFinding[]) {
  return findings.map(({ code, severity, message, evidence }) => ({ code, severity, message,
    evidence: evidence.filter(e => e.length <= 1000),
    evidenceOmitted: evidence.filter(e => e.length > 1000).length }));
}

export function coverageWorklist(plan: TestPlan, minimumConfidence: number) {
  const tests = [...plan.cases, ...plan.workflows.flatMap(w => [...w.steps, ...(w.cleanupSteps ?? [])])];
  const pending = (plan.discovery?.candidates ?? []).filter(c => ['llm','requirement'].includes(c.origin ?? '')
    && c.disposition !== 'reject' && c.confidence >= minimumConfidence
    && !tests.some(t => t.discovery?.candidateIds.includes(c.id)));
  return { instruction: 'Implement and link the following batch before adding unrelated tests. Reuse existing cases through coverageLinks when their assertions prove the criterion; otherwise add assertions or a workflow. Links alone never verify behavior. Include every applicable requirement ID, not only a similar semantic discovery ID. Report unavailable oracles explicitly. Remaining items stay pending for subsequent builds.',
    remaining: pending.length, batch: pending.sort((a,b) => Number(b.origin === 'requirement') - Number(a.origin === 'requirement')).slice(0,12)
      .map(c => ({ id:c.id, title:c.title, operationId:c.operationId, operationIds:c.operationIds, scenario:c.scenario })) };
}

export type LeadAction = 'build' | 'execute' | 'heal' | 'accept' | 'block';
export class LeadAgent {
  constructor(private readonly provider: AgentProvider) {}
  async decide(config: GauntletConfig, input: unknown, allowedActions: LeadAction[]): Promise<{ action: LeadAction; reason: string; invocation: AgentReply }> {
    const invocation = await this.provider.invoke('lead', config.agents.leadModel ?? config.agents.builderModel,
      loadPrompt('lead'),
      { objective: 'Discover, implement, execute and refine API tests until acceptance criteria pass or a genuine blocker is evidenced.', state: input, allowedActions });
    const output = record(invocation.output, 'lead decision');
    if (!allowedActions.includes(output.action as LeadAction)) throw new Error(`AGENT_LEAD_ACTION_DENIED: ${output.action}`);
    return { action: output.action as LeadAction, reason: string(output.reason, 'lead reason'), invocation };
  }
}

export class HealerAgent {
  constructor(private readonly provider: AgentProvider) {}
  async repair(contract: NormalizedContract, config: GauntletConfig, plan: TestPlan, evidence: unknown): Promise<{ plan: TestPlan; hypothesis: string; classification: string; invocation: AgentReply }> {
    const invocation = await this.provider.invoke('healer', config.agents.healerModel ?? config.agents.builderModel,
      loadPrompt('healer'),
      { contract: { operations: contract.operations, document: contract.document }, plan: { ...plan, discovery: compactDiscovery(plan.discovery) }, evidence, safety: config.safety,
        fixtures: config.fixtures ? { bindings: FIXTURE_BINDINGS, observations: FIXTURE_OBSERVATION_GUIDE, lifecycle: 'Fresh per-test Customer A (one order), Customer B (no orders), Employee/Chef, menu items, and paginationCustomer (101 orders for default-limit and offset tests). Cleaned after every independent test. Use the symbolic bindings for setup; never invent IDs or change auth intent.' } : undefined,
        minimumDiscoveryConfidence: config.discovery.minimumConfidence,
        investigationRules: ['Review execution.observations, including successful earlier requests, before classifying a defect.',
          'Seed/example data describes initial state only. Earlier DELETE, reset, or create requests may change the precondition.',
          'A duplicate test requires a matching record to exist immediately before the duplicate request. Check successful setup and deletion evidence.',
          'When preconditions are unproven, establish them using setupSteps and rerun the unchanged assertion before declaring a product defect.'] });
    const output = record(invocation.output, 'healer output');
    const classification = string(output.classification, 'classification');
    if (!['test-implementation', 'product-defect', 'infrastructure', 'contract-gap'].includes(classification)) throw new Error('AGENT_OUTPUT_INVALID: healer classification');
    const hypothesis = string(output.hypothesis, 'hypothesis');
    return { plan: classification === 'test-implementation' ? applyAgentPlan(plan, output.changes, contract, config, true) : plan, hypothesis, classification, invocation };
  }
}
