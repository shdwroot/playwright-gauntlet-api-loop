import { contextLimits, measureContext, shareContextSchemas, candidateContext, planContext, contractContext, executionContext, unitIndex, boundedEvidence } from './agent-context.js';
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
  context?: ReturnType<typeof measureContext>;
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
  private calls = 0;
  private inputCharacters = 0;
  constructor(private readonly config: AgentConfig) {}

  async invoke(role: AgentRole, model: string, system: string, input: unknown, transportInstructions?: string): Promise<AgentReply> {
    const azure = this.config.provider === 'azure';
    const apiKeyEnv = this.config.apiKeyEnv ?? (azure ? 'AZURE_OPENAI_API_KEY' : 'OPENAI_API_KEY');
    const apiKey = process.env[apiKeyEnv];
    if (!apiKey) throw new Error(`CREDENTIAL_MISSING: ${apiKeyEnv}`);
    const baseUrl = (this.config.openaiBaseUrl ?? 'https://api.openai.com').replace(/\/$/, '');
    const sanitized = redactAgentData(input);
    const prompt = stableStringify(sanitized, 0);
    const limits = contextLimits(this.config);
    const context = measureContext(role, system, sanitized, transportInstructions);
    if (context.totalCharacters > limits.maxInputCharacters) throw new Error(`AGENT_INPUT_LIMIT: ${role} assembled context has ${context.totalCharacters} characters; maximum ${limits.maxInputCharacters}. Split the assigned work; no input was truncated.`);
    if (this.calls >= limits.maxCalls || this.inputCharacters + context.totalCharacters > limits.maxRunInputCharacters) throw new Error('AGENT_RUN_BUDGET_EXHAUSTED: model call or cumulative input budget reached; completed evidence is retained');
    this.calls++; this.inputCharacters += context.totalCharacters;
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
        max_output_tokens: limits.maxOutputTokens,
        instructions,
        text: { format: { type: 'json_schema', name: `${role}_response`, strict: true, schema } },
        input: `Return only valid JSON.\n${prompt}`,
      }),
    }, this.config.timeoutMs ?? 120_000, role);
    const responseText = await response.text();
    if (responseText.length > 2_000_000) throw new Error('AGENT_RESPONSE_LIMIT');
    const payload = JSON.parse(responseText) as Record<string, unknown>;
    if (payload.status === 'incomplete') throw new Error('AGENT_OUTPUT_INCOMPLETE: response exceeded an output/model limit; split the work or review maxOutputTokens');
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
      promptHash, responseHash: sha256(stableStringify(output)), durationMs, context,
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
    const worklist = coverageWorklist(baseline, config.discovery.minimumConfidence);
    const allCandidates = (baseline.discovery ?? discovery)?.candidates ?? [];
    const feedbackText = stableStringify(compactFindings(feedback),0);
    const pendingIds = new Set(worklist.batch.map(c=>c.id));
    const eligible = allCandidates.filter(c=>c.confidence >= config.discovery.minimumConfidence && c.disposition !== 'reject');
    let selected = [...eligible.filter(c=>feedbackText.includes(c.id)), ...eligible.filter(c=>pendingIds.has(c.id))]
      .filter((c,i,a)=>a.findIndex(v=>v.id===c.id)===i).slice(0,contextLimits(config.agents).reviewBatchSize);
    if (!selected.length) selected=eligible.slice(0,contextLimits(config.agents).reviewBatchSize);
    const system=loadPrompt('builder');
    const makeInput = (focused: boolean) => {
      const operations = new Set(selected.flatMap(c=>[...(c.operationId?[c.operationId]:[]),...(c.operationIds ?? [])]));
      const units = new Set(unitIndex(baseline).filter(u=>u.operationIds.some(id=>operations.has(id)) || feedbackText.includes(u.id)).map(u=>u.id));
      if (!operations.size) for(const o of contract.operations.slice(0,contextLimits(config.agents).reviewBatchSize)) operations.add(o.operationId);
      for(const w of baseline.workflows.filter(w=>units.has(w.id))) for(const t of [...w.steps,...(w.cleanupSteps ?? [])]) operations.add(t.operationId);
      for(const c of baseline.cases.filter(c=>units.has(c.id))) operations.add(c.operationId);
      return shareContextSchemas({ contract: focused ? contractContext(contract,operations) : {operations:contract.operations,document:contract.document,workflows:contract.workflows},
        currentPlan: planContext(baseline,units),
        existingTestIndex: unitIndex(baseline).filter(u=>units.has(u.id)),
        scope: { selectedCandidateIds:selected.map(c=>c.id), deferredCandidateCount:eligible.filter(c=>!selected.some(s=>s.id===c.id)).length,
          omittedPlanUnits: baseline.cases.length+baseline.workflows.length-units.size,
          instruction:'Only this batch is assigned. The full plan is retained and returned proposals are merged into it. Do not duplicate selected existing tests or claim coverage from an index alone. Missing dependencies/oracles remain explicit risk notes.' },
        discovery: { candidates:selected.map(candidateContext) }, feedback:compactFindings(feedback), isolation:config.isolation,
        coverageWorklist:{...worklist,batch:selected.map(c=>({id:c.id,title:c.title,operationId:c.operationId,operationIds:c.operationIds,scenario:c.scenario}))},
        fixtures: config.fixtures ? { adapter: config.fixtures.adapter, bindings: FIXTURE_BINDINGS, observations: FIXTURE_OBSERVATION_GUIDE,
          lifecycle: 'Fresh Customer A/B, Employee, Chef, menu item, unreferenced menu item, and Customer A order before each independent case/workflow. They are cleaned afterwards. Use ${customerAToken} etc in bearer headers; ${fixturePassword} is their valid password. ${tamperedSubjectToken} is a copy of A token with subject changed to B without resigning, for SEC-001. ${runId} is the per-test owned namespace. Register new users with username beginning ${runId}- so cleanup owns them. Customer A has an unused 20-percent coupon (${fixtureCouponId}) and a prepared reset code (${fixtureResetCode}). Customer B starts without orders and without reset initiation. A separate paginationCustomer starts with 101 orders: use ${paginationCustomerToken} to test default limit 100, explicit limits and skips; ${paginationOrderCount} is 101. No fixture values are model-visible. Use setupSteps/workflows for scenario-specific state. This is fixture setup, not evidence that the API behavior passes.' } : undefined,
        minimumDiscoveryConfidence:config.discovery.minimumConfidence, requestBudget:config.safety.maxRequestsPerRun,
        maxAgentCasesPerOperation:config.discovery.maxCandidatesPerOperation,safety:config.safety });
    };
    let input=makeInput(false);
    if (measureContext('builder',system,input).totalCharacters > contextLimits(config.agents).maxInputCharacters) input=makeInput(true);
    while(selected.length > 1 && measureContext('builder',system,input).totalCharacters > contextLimits(config.agents).maxInputCharacters) {
      selected=selected.slice(0,Math.ceil(selected.length/2));input=makeInput(true);
    }
    const invocation = await this.provider.invoke('builder',config.agents.builderModel,system,input);
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

export function compactLeadState(input: unknown): unknown {
  if (!input || typeof input !== 'object') return input;
  const state=input as any;
  return { ...state,
    discovery: state.discovery ? {candidateCount:state.discovery.candidates?.length,sourceCount:state.discovery.sourceCount,discoveryHash:state.discovery.discoveryHash} : undefined,
    backlog: state.backlog ? {total:state.backlog.length,byStatus:state.backlog.reduce((counts:Record<string,number>,o:any)=>({...counts,[o.status]:(counts[o.status] ?? 0)+1}),{}),
      pending:state.backlog.filter((o:any)=>!['verified','superseded'].includes(o.status)).slice(0,8)} : undefined,
    history: state.history?.slice(-4), historyCount:state.history?.length,
    plan: state.plan ? {operationCount:state.plan.operations?.length,caseCount:state.plan.cases?.length,workflowCount:state.plan.workflows?.length,
      blockedOperations:state.plan.operations?.filter((o:any)=>o.blockedReason && !o.coveredBy?.length).slice(0,8),
      cases:state.plan.cases?.slice(0,8),workflows:state.plan.workflows?.slice(0,4)} : undefined,
    execution: state.execution ? {...executionContext(state.execution),failures:executionContext(state.execution).failures.slice(0,8),observations:undefined} : undefined,
    verdict: state.verdict ? {...state.verdict,findings:state.verdict.findings?.slice(0,8),findingCount:state.verdict.findings?.length} : undefined,
    summaryScope:'Bounded manager overview. Coverage worklist and deterministic gates remain authoritative; omitted items stay in the backlog and run evidence. Never infer acceptance from an incomplete overview.' };
}

export type LeadAction = 'build' | 'execute' | 'heal' | 'accept' | 'block';
export class LeadAgent {
  constructor(private readonly provider: AgentProvider) {}
  async decide(config: GauntletConfig, input: unknown, allowedActions: LeadAction[]): Promise<{ action: LeadAction; reason: string; invocation: AgentReply }> {
    const invocation = await this.provider.invoke('lead', config.agents.leadModel ?? config.agents.builderModel,
      loadPrompt('lead'),
      { objective: 'Discover, implement, execute and refine API tests until acceptance criteria pass or a genuine blocker is evidenced.', state: compactLeadState(input), allowedActions });
    const output = record(invocation.output, 'lead decision');
    if (!allowedActions.includes(output.action as LeadAction)) throw new Error(`AGENT_LEAD_ACTION_DENIED: ${output.action}`);
    return { action: output.action as LeadAction, reason: string(output.reason, 'lead reason'), invocation };
  }
}

export class HealerAgent {
  constructor(private readonly provider: AgentProvider) {}
  async repair(contract: NormalizedContract, config: GauntletConfig, plan: TestPlan, evidence: unknown): Promise<{ plan: TestPlan; hypothesis: string; classification: string; invocation: AgentReply }> {
    const source=evidence as {execution?:import('./types.js').ExecutionSummary;latestError?:unknown;history?:unknown[];verdict?:unknown};
    const failures=source.execution?.failures ?? [];
    const focus=failures.slice(0,2);
    const units=new Set(unitIndex(plan).filter(u=>focus.some(f=>f.title.startsWith(`[${u.id}] `)||f.title.startsWith(`[workflow:${u.id}] `))).map(u=>u.id));
    const focused=planContext(plan,units);
    const operations=new Set([...focused.cases,...focused.workflows.flatMap(w=>[...w.steps,...(w.cleanupSteps ?? [])])].map(c=>c.operationId));
    const candidateIds=new Set([...focused.cases,...focused.workflows.flatMap(w=>w.steps)].flatMap(c=>c.discovery?.candidateIds ?? []));
    const invocation = await this.provider.invoke('healer', config.agents.healerModel ?? config.agents.builderModel,
      loadPrompt('healer'),shareContextSchemas({contract:contractContext(contract,operations),
        plan:{...focused,discovery:{candidates:plan.discovery?.candidates.filter(c=>candidateIds.has(c.id)).map(candidateContext) ?? []}},
        evidence:{execution:source.execution?executionContext(source.execution,units,true):undefined,latestError:source.latestError,
          history:source.history?.slice(-3),verdict:boundedEvidence(source.verdict,4000)},
        scope:{selectedUnits:[...units],deferredFailures:Math.max(0,failures.length-focus.length),instruction:'Diagnose only these complete failing units. Other failures remain recorded and unresolved; do not claim to repair them.'},safety:config.safety,
        fixtures: config.fixtures ? { bindings: FIXTURE_BINDINGS, observations: FIXTURE_OBSERVATION_GUIDE, lifecycle: 'Fresh per-test Customer A (one order), Customer B (no orders), Employee/Chef, menu items, and paginationCustomer (101 orders for default-limit and offset tests). Cleaned after every independent test. Use the symbolic bindings for setup; never invent IDs or change auth intent.' } : undefined,
        minimumDiscoveryConfidence:config.discovery.minimumConfidence,
        investigationRules:['Inspect successful setup in the selected workflow before attributing downstream failures. Missing or omitted evidence remains unknown.',
          'Use setupSteps to establish preconditions before the original failing test; preserve every existing assertion.'] }));
    const output = record(invocation.output, 'healer output');
    const classification = string(output.classification, 'classification');
    if (!['test-implementation', 'product-defect', 'infrastructure', 'contract-gap'].includes(classification)) throw new Error('AGENT_OUTPUT_INVALID: healer classification');
    const hypothesis = string(output.hypothesis, 'hypothesis');
    return { plan: classification === 'test-implementation' ? applyAgentPlan(plan, output.changes, contract, config, true) : plan, hypothesis, classification, invocation };
  }
}
