import { contextLimits, measureContext, shareContextSchemas, planContext, executionContext } from './agent-context.js';
import { loadPrompt } from './prompts.js';
import { FIXTURE_OBSERVATION_GUIDE } from './fixtures.js';
import type { AgentProvider } from './agents.js';
import type { CriticFinding, DiscoveryCandidate, DiscoveryReport, ExecutionSummary, GauntletConfig, TestPlan } from './types.js';
import { sha256, stableStringify } from './utils.js';

export interface CoverageObligation {
  id: string;
  candidate: DiscoveryCandidate;
  status: 'unimplemented' | 'implemented' | 'verified' | 'gap' | 'needs-review' | 'superseded';
  replacedBy?: string[];
  reason: string;
  proofs: Array<{ testId: string; assertionPointers: string[] }>;
}
export interface CoverageBacklog { formatVersion: 1; sourceRevision: string; obligations: CoverageObligation[]; }

// Discovery is nondeterministic. Never silently forget an obligation on rediscovery.
export function reconcileCoverage(discovery: DiscoveryReport, previous?: CoverageBacklog): CoverageBacklog {
  const sourceRevision = sha256(stableStringify({ specHash: discovery.specHash, sources: discovery.sources.map(s => [s.sourcePath, s.sourceHash]).sort() }));
  const candidates = new Map(discovery.candidates.map(c => [c.id, c]));
  const stale: CoverageObligation[] = [];
  for (const obligation of previous?.obligations ?? []) {
    if (obligation.status === 'superseded') { if (!candidates.has(obligation.id)) stale.push(obligation); continue; }
    const rediscovered = candidates.get(obligation.id);
    if (rediscovered) {
      // Model confidence or disposition changes cannot silently waive an existing obligation.
      candidates.set(obligation.id, { ...rediscovered, confidence: Math.max(rediscovered.confidence, obligation.candidate.confidence),
        disposition: rediscovered.disposition === 'reject' ? obligation.candidate.disposition : rediscovered.disposition });
      continue;
    }
    if (previous?.sourceRevision === sourceRevision && obligation.status !== 'needs-review') candidates.set(obligation.id, obligation.candidate);
    else stale.push({ ...obligation, status: 'needs-review', proofs: [], reason: 'Source changed; prior obligation requires reconciliation before acceptance.' });
  }
  discovery.candidates = [...candidates.values()];
  const { discoveryHash: _, ...unsigned } = discovery;
  discovery.discoveryHash = sha256(stableStringify(unsigned));
  return { formatVersion: 1, sourceRevision, obligations: [...candidates.values()].filter(c => (c.origin === 'llm' || c.origin === 'requirement') && c.disposition !== 'reject').map<CoverageObligation>(candidate => ({ id: candidate.id, candidate, status: 'unimplemented' as const, reason: 'Requires fresh execution and assertion review.', proofs: [] })).concat(stale) };
}

function resolves(test: unknown, pointer: string): boolean {
  if (!/^\/(?:assertions\/\d+|expected\/(?:statuses|contentType|schema\/.+|variants\/\d+\/(?:contentType|schema\/.+)))$/.test(pointer)) return false;
  let value = test;
  for (const key of pointer.slice(1).split('/').map(k => k.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) return false;
    value = (value as Record<string, unknown>)[key];
  }
  return value !== undefined;
}

function assertionCatalog(test: import('./types.js').TestCasePlan, statuses: number[] = []): string[] {
  const pointers = ['/expected/statuses', ...(test.expected.contentType ? ['/expected/contentType'] : []), ...(test.assertions ?? []).flatMap((a, i) => !a.whenStatuses || a.whenStatuses.some(s=>statuses.includes(s)) ? [`/assertions/${i}`] : [])];
  const visit = (value: unknown, prefix: string) => {
    if (!value || typeof value !== 'object') return;
    const schema = value as Record<string, unknown>;
    for (const key of ['type', 'const', 'enum', 'required', 'minItems', 'maxItems', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum']) {
      if (schema[key] !== undefined) pointers.push(`${prefix}/${key}`);
    }
    if (schema.additionalProperties === false) pointers.push(`${prefix}/additionalProperties`);
    if (schema.nullable === true) pointers.push(`${prefix}/nullable`);
    if (schema.format === 'email') pointers.push(`${prefix}/format`);
    for (const [key, child] of Object.entries((schema.properties ?? {}) as Record<string, unknown>)) visit(child, `${prefix}/properties/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`);
    if (schema.items) visit(schema.items, `${prefix}/items`);
    for (const key of ['allOf', 'anyOf', 'oneOf']) if (Array.isArray(schema[key])) (schema[key] as unknown[]).forEach((child, i) => visit(child, `${prefix}/${key}/${i}`));
  };
  if (test.expected.schema) visit(test.expected.schema, '/expected/schema');
  test.expected.variants?.forEach((variant,index)=>{
    if (!statuses.includes(variant.status)) return;
    if (variant.contentType) pointers.push(`/expected/variants/${index}/contentType`);
    if (variant.schema) visit(variant.schema,`/expected/variants/${index}/schema`);
  });
  return pointers;
}

export async function verifyCoverage(provider: AgentProvider, config: GauntletConfig, plan: TestPlan, execution: ExecutionSummary, backlog: CoverageBacklog) {
  const tests = [...plan.cases, ...plan.workflows.flatMap(w => [...w.steps, ...(w.cleanupSteps ?? [])])];
  const required = backlog.obligations.filter(o => o.status !== 'superseded' && o.candidate.confidence >= config.discovery.minimumConfidence);
  const statuses = (id:string) => (execution.observations ?? []).filter(o=>o.status === 'passed').flatMap(o=>o.exchanges.flatMap(value=>{
    const exchange=value as {request?:{caseId?:unknown};response?:{status?:unknown}} | null;
    return exchange?.request?.caseId === id && typeof exchange?.response?.status === 'number' ? [exchange.response.status] : [];
  }));
  const passed = (testId: string) => {
    const workflow = plan.workflows.find(w => [...w.steps, ...(w.cleanupSteps ?? [])].some(s => s.id === testId));
    const unitId = workflow ? `workflow:${workflow.id}` : testId;
    return execution.observations?.some(o => o.title.startsWith(`[${unitId}] `) && o.status === 'passed');
  };
  const proofCatalog = Object.fromEntries(required.map(o => [o.id, tests.filter(t => t.discovery?.candidateIds.includes(o.id) && passed(t.id)).map(t => ({ testId: t.id, assertionPointers: assertionCatalog(t,statuses(t.id)) }))]));
  // An obligation with no linked passing test cannot be verified. Do not spend
  // model output on hundreds of identical gap assessments. Retain those full
  // obligations for reconciliation and report them as deterministic gaps below.
  const reviewable = required.filter(o => proofCatalog[o.id]!.length > 0);
  type Review = { reconciliations?: Array<{ obligationId: string; replacementIds: string[]; reason: string }>; assessments?: Array<{ obligationId: string; verdict: string; reason: string; proofs: Array<{ testId: string; assertionPointers: string[] }> }>; isolation?: Array<{ unitId: string; verdict: string; reason: string }> };
  const output: Required<Review> = { assessments: [], reconciliations: [], isolation: [] };
  const invocations: import('./agents.js').AgentReply[] = [];
  const batches: Array<{phase:string;obligationIds:string[];unitIds:string[];characters:number;status:string;error?:string}> = [];
  const batchFindings: CriticFinding[] = [];
  const limits = contextLimits(config.agents);
  const system = loadPrompt('verifier');
  const isolated = new Set<string>();
  let halted: string | undefined;
  const unitFor = (id: string) => plan.workflows.find(w => [...w.steps,...(w.cleanupSteps ?? [])].some(t => t.id === id))?.id ?? id;
  const fixtureContext = config.fixtures ? {
    fixtureObservations: FIXTURE_OBSERVATION_GUIDE,
    fixtureLifecycle: 'The runner provisions fresh Customer A/B, Employee/Chef, menu items, an A-owned order and a paginationCustomer with 101 orders per standalone case/workflow; namespace-owned records are cleaned in finally. Values are per-unit. Scenario-specific preparation may still be needed. Fixture setup alone does not prove the API criterion.'
  } : {};
  async function dispatch(phase: string, obligations: CoverageObligation[], units: string[], unverified: CoverageObligation[] = [], replacements: CoverageObligation[] = []): Promise<void> {
    const obligationIds = new Set(obligations.map(o => o.id));
    const unitIds = new Set(units);
    const isolationUnitIds = config.quality.requireIsolationReview ? units.filter(id => !isolated.has(id)) : [];
    const state = shareContextSchemas({ phase, obligations, unverifiedObligations: unverified, verifiedReplacements: replacements,
      unverifiedInstruction: 'Unverified criteria remain gaps. Reconcile only supplied unverified IDs to supplied freshly verified replacements, preserving every applicable behavior. No assessment may claim unseen evidence.',
      proofCatalog: Object.fromEntries(obligations.map(o => [o.id,proofCatalog[o.id]])),
      plan: planContext(plan,unitIds), isolationUnitIds,
      ...fixtureContext, execution: executionContext(execution,unitIds),
      evidenceScope: { planUnitsIncluded: units.length, planUnitsTotal: plan.cases.length + plan.workflows.length,
        instruction: 'This is one bounded batch. Review only assigned obligations and isolationUnitIds. Other batches are merged by the runtime. Full evidence remains in the run artifacts.' },
    });
    const characters = measureContext('verifier',system,state).totalCharacters;
    if (characters > limits.maxInputCharacters) {
      if (obligations.length > 1) {
        const middle=Math.ceil(obligations.length/2);
        for (const half of [obligations.slice(0,middle),obligations.slice(middle)]) await dispatch(phase,half,[...new Set(half.flatMap(o => proofCatalog[o.id]!.map(t => unitFor(t.testId))))]);
        return;
      }
      if (!obligations.length && units.length > 1) {
        const middle=Math.ceil(units.length/2);await dispatch(phase,[],units.slice(0,middle));await dispatch(phase,[],units.slice(middle));return;
      }
      if (unverified.length > 1) {
        const middle=Math.ceil(unverified.length/2);await dispatch(phase,[],[],unverified.slice(0,middle),replacements);await dispatch(phase,[],[],unverified.slice(middle),replacements);return;
      }
      if (replacements.length > 1) {
        const middle=Math.ceil(replacements.length/2);await dispatch(phase,[],[],unverified,replacements.slice(0,middle));await dispatch(phase,[],[],unverified,replacements.slice(middle));return;
      }
      const error='VERIFIER_UNIT_TOO_LARGE: one indivisible review exceeds the context budget; criterion remains unverified';
      batches.push({phase,obligationIds:[...obligationIds,...unverified.map(o=>o.id)],unitIds:units,characters,status:'oversized',error});
      batchFindings.push({code:'VERIFIER_CONTEXT_GAP',severity:'blocking',message:error,evidence:[...obligationIds,...unverified.map(o=>o.id),...units]});return;
    }
    if (halted) { batches.push({phase,obligationIds:[...obligationIds,...unverified.map(o=>o.id)],unitIds:units,characters,status:'not-run',error:halted});return; }
    try {
      const invocation=await provider.invoke('verifier',config.agents.verifierModel ?? config.agents.criticModel,system,state);
      invocations.push(invocation);
      const result=invocation.output as Review;
      output.assessments.push(...(result.assessments ?? []).filter(a=>obligationIds.has(a.obligationId)));
      output.isolation.push(...(result.isolation ?? []).filter(a=>isolationUnitIds.includes(a.unitId)));
      for (const id of isolationUnitIds) isolated.add(id);
      output.reconciliations.push(...(result.reconciliations ?? []).filter(r=>unverified.some(o=>o.id===r.obligationId) && r.replacementIds?.length && r.replacementIds.every(id=>replacements.some(o=>o.id===id))));
      batches.push({phase,obligationIds:[...obligationIds,...unverified.map(o=>o.id)],unitIds:units,characters,status:'completed'});
    } catch (error) {
      const message=error instanceof Error ? error.message : String(error);
      batches.push({phase,obligationIds:[...obligationIds,...unverified.map(o=>o.id)],unitIds:units,characters,status:'failed',error:message});
      batchFindings.push({code:'VERIFIER_BATCH_FAILED',severity:'blocking',message,evidence:[...obligationIds,...units]});
      if (/BUDGET_EXHAUSTED|QUOTA_EXHAUSTED|CREDENTIAL_MISSING/.test(message)) halted=message;
    }
  }
  for (let i=0;i<reviewable.length;i+=limits.reviewBatchSize) {
    const batch=reviewable.slice(i,i+limits.reviewBatchSize);
    await dispatch('semantic',batch,[...new Set(batch.flatMap(o=>proofCatalog[o.id]!.map(t=>unitFor(t.testId))))]);
  }
  if (config.quality.requireIsolationReview) {
    const remaining=[...plan.cases.map(c=>c.id),...plan.workflows.map(w=>w.id)].filter(id=>!isolated.has(id));
    for(let i=0;i<remaining.length;i+=limits.reviewBatchSize) await dispatch('isolation',[],remaining.slice(i,i+limits.reviewBatchSize));
  }
  const findings: CriticFinding[] = [];
  for (const obligation of required) {
    const reviews = output?.assessments?.filter(a => a.obligationId === obligation.id) ?? [];
    const assessment = reviews.length === 1 ? reviews[0] : undefined;
    const proofs = Array.isArray(assessment?.proofs) ? assessment.proofs : [];
    const valid = proofs.length > 0 && proofs.every(proof => {
      const t = tests.find(t => t.id === proof.testId);
      const workflow = plan.workflows.find(w => [...w.steps, ...(w.cleanupSteps ?? [])].some(s => s.id === proof.testId));
      const titleId = workflow ? `workflow:${workflow.id}` : proof.testId;
      return t?.discovery?.candidateIds.includes(obligation.id) && Array.isArray(proof.assertionPointers) && proof.assertionPointers.length > 0
        && proof.assertionPointers.every(p => typeof p === 'string' && assertionCatalog(t,statuses(t.id)).includes(p) && resolves(t, p))
        && execution.observations?.some(o => o.title.startsWith(`[${titleId}] `) && o.status === 'passed');
    });
    if (obligation.status !== 'needs-review') obligation.status = assessment?.verdict === 'verified' && valid ? 'verified' : 'gap';
    obligation.reason = assessment?.reason ?? (reviews.length > 1 ? 'Verifier returned duplicate assessments.' : !proofCatalog[obligation.id]!.length
      ? 'No linked passing test proves this obligation; build or repair its assertions and link its criterion ID.' : 'Verifier omitted this obligation.');
    if (assessment?.verdict === 'verified' && !valid) obligation.reason += ' Proof rejected: use linked step IDs, existing assertion pointers, and passing observations.';
    obligation.proofs = valid ? proofs : [];
  }
  // Reconciliation is a separate bounded semantic comparison after replacement
  // proofs have passed their deterministic checks. Explicit current requirement
  // gaps are never waived as duplicates; stale criteria and unlinked LLM
  // proposals may be mapped only to freshly verified replacement criteria.
  const reconcile=required.filter(o=>o.status==='needs-review' || (o.status!=='verified' && o.candidate.origin==='llm' && !proofCatalog[o.id]?.length));
  const verified=required.filter(o=>o.status==='verified');
  for(let i=0;i<reconcile.length && verified.length;i+=limits.reviewBatchSize) await dispatch('reconciliation',[],[],reconcile.slice(i,i+limits.reviewBatchSize),verified);
  for (const obligation of required.filter(o => o.status !== 'verified')) {
    const matches = output?.reconciliations?.filter(r => r.obligationId === obligation.id) ?? [];
    const reconciliation = matches.length === 1 ? matches[0] : undefined;
    if (reconciliation && typeof reconciliation.reason === 'string' && reconciliation.reason.trim() && Array.isArray(reconciliation.replacementIds) && reconciliation.replacementIds.length
      && reconciliation.replacementIds.every(id => required.some(o => o.id === id && o.status === 'verified'))) {
      obligation.status = 'superseded'; obligation.replacedBy = reconciliation.replacementIds; obligation.reason = reconciliation.reason;
    }
  }
  for (const obligation of required) {
    if (config.quality.requireSemanticVerification && !['verified', 'superseded'].includes(obligation.status)) findings.push({ code: 'SEMANTIC_COVERAGE_GAP', severity: 'blocking', message: `${obligation.id}: ${obligation.reason}`, evidence: [stableStringify(obligation)] });
  }
  if (config.quality.requireIsolationReview) {
    for (const unitId of [...plan.cases.map(t => t.id), ...plan.workflows.map(w => w.id)]) {
      const assessments = output?.isolation?.filter(a => a.unitId === unitId) ?? [];
      if (assessments.length !== 1 || assessments[0]?.verdict !== 'isolated') findings.push({ code: 'TEST_ISOLATION_GAP', severity: 'blocking', message: `${unitId}: ${assessments[0]?.reason ?? 'Missing isolation review'}`, evidence: [unitId] });
    }
  }
  findings.push(...batchFindings);
  return { invocation: invocations.at(-1), invocations, batches, findings };
}
