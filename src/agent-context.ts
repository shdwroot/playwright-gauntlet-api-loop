import { agentOutputSchema } from './agent-protocol.js';
import { redactAgentData } from './agent-redaction.js';
import { loadPrompt } from './prompts.js';
import { sha256, stableStringify } from './utils.js';
import type { AgentConfig, DiscoveryCandidate, ExecutionSummary, NormalizedContract, TestPlan } from './types.js';

export function contextLimits(config: AgentConfig) {
  return { maxInputCharacters: config.maxInputCharacters ?? 160_000, maxRunInputCharacters: config.maxRunInputCharacters ?? 3_000_000,
    maxCalls: config.maxCalls ?? 60, maxOutputTokens: config.maxOutputTokens ?? 8000, reviewBatchSize: config.reviewBatchSize ?? 8 };
}

export function measureContext(role: string, system: string, input: unknown, transport = loadPrompt('transport')) {
  const sanitized = redactAgentData(input);
  const inputCharacters = stableStringify(sanitized, 0).length;
  const instructionCharacters = system.length + 1 + transport.length;
  const schemaCharacters = stableStringify(agentOutputSchema(role, sanitized), 0).length;
  return { inputCharacters, instructionCharacters, schemaCharacters, totalCharacters: inputCharacters + instructionCharacters + schemaCharacters };
}

// Lossless schema sharing in MODEL INPUT only. Runtime plans and proof pointers
// remain unchanged. A reference resolves against the same input's contextSchemas.
export function shareContextSchemas<T>(input: T): T & { contextSchemas: Record<string, unknown> } {
  const schemas: Record<string, unknown> = {};
  function visit(value: unknown, key = ''): unknown {
    if (key === 'schema' && value && typeof value === 'object') {
      const id = sha256(stableStringify(value, 0)); schemas[id] = value;
      return { $ref: `#/contextSchemas/${id}` };
    }
    if (Array.isArray(value)) return value.map(v => visit(v));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, visit(v, k)]));
    return value;
  }
  return { ...(visit(input) as T), contextSchemas: schemas };
}

export function candidateContext(candidate: DiscoveryCandidate) {
  const { id, origin, signal, title, operationId, operationIds, confidence, disposition, scenario, rationale, reason, contractPointers, evidence } = candidate;
  return { id, origin, signal, title, operationId, operationIds, confidence, disposition, scenario, rationale, reason, contractPointers, evidence };
}

export function planContext(plan: TestPlan, unitIds?: Set<string>) {
  const test = <T extends import('./types.js').TestCasePlan>(value:T):T => ({...value,
    ...(value.discovery ? {discovery:{...value.discovery,evidence:[]}} : {})});
  return { specHash: plan.specHash, isolation: plan.isolation,
    cases: plan.cases.filter(c => !unitIds || unitIds.has(c.id)).map(test),
    workflows: plan.workflows.filter(w => !unitIds || unitIds.has(w.id)).map(w=>({...w,steps:w.steps.map(test),...(w.cleanupSteps?{cleanupSteps:w.cleanupSteps.map(test)}:{})})),
    evidenceScope:'Repeated per-test discovery excerpts are omitted here; criterion evidence is supplied with assigned candidates/obligations and retained in the full plan artifact. Test requests, assertions, expected responses and capture/setup/cleanup relationships are preserved.'
  };
}

export function executionContext(execution: ExecutionSummary, unitIds?: Set<string>, includeExchanges = false) {
  const belongs = (title: string) => !unitIds || [...unitIds].some(id => title.startsWith(`[${id}] `) || title.startsWith(`[workflow:${id}] `));
  const observations = (execution.observations ?? []).filter(o => belongs(o.title));
  return { status: execution.status, tests: execution.tests, passed: execution.passed, failed: execution.failed, skipped: execution.skipped,
    failures: (execution.failures ?? []).filter(f => belongs(f.title)).map(f => ({ title:f.title, messages:[...new Set(f.messages)].slice(0,1).map(m=>boundedEvidence(m,1800)), ...(includeExchanges ? {exchanges:(f.exchanges ?? []).map(v=>boundedEvidence(v))} : {}) })),
    observations: observations.map(o => ({ title:o.title, status:o.status,
      exchanges: (o.exchanges ?? []).map(value => {
        const e = value as {request?:{caseId?:string};response?:{status?:number}};
        return includeExchanges ? boundedEvidence(value) : {request:{caseId:e?.request?.caseId},response:{status:e?.response?.status}};
      }) })),
    evidenceScope: { selectedUnits: unitIds ? [...unitIds] : 'all', rawExchangesIncluded: includeExchanges,
      omittedObservationCount: (execution.observations ?? []).length - observations.length,
      artifacts: ['execution.json', 'test-results'],
      instruction: 'Passing observations establish execution of the cited assertions only. Raw exchanges remain in execution artifacts; missing facts cannot be invented or used as proof.' },
  };
}

// Preserve original JSON Pointer locations and include transitive local $refs.
// No model can authorize an operation removed from this focused view; the full
// contract remains authoritative when validating the returned proposal.
export function contractContext(contract: NormalizedContract, operationIds: Set<string>) {
  const operations = contract.operations.filter(o => operationIds.has(o.operationId));
  const document: Record<string, unknown> = {};
  const copy = (pointer: string) => {
    const keys = pointer.replace(/^#/, '').split('/').slice(1).map(k => k.replaceAll('~1','/').replaceAll('~0','~'));
    let source: any = contract.document; let target: any = document;
    for (const [index,key] of keys.entries()) {
      if (!source || typeof source !== 'object' || !Object.hasOwn(source,key)) return;
      source = source[key];
      if (index === keys.length - 1) target[key] = structuredClone(source);
      else target = target[key] ??= {};
    }
  };
  for (const key of ['openapi','swagger','info','security','servers']) if (contract.document[key] !== undefined) document[key] = contract.document[key];
  for (const operation of operations) {
    copy(operation.sourcePointer);
    const parent = operation.sourcePointer.slice(0,operation.sourcePointer.lastIndexOf('/'));
    copy(`${parent}/parameters`);
  }
  copy('/components/securitySchemes'); copy('/securityDefinitions');
  const oracles = contract.document['x-gauntlet-requirement-oracles'];
  if (oracles && typeof oracles === 'object') for (const [key,value] of Object.entries(oracles)) {
    const oracle = value as {method?:string;path?:string};
    if (operations.some(o=>o.path===oracle.path && o.method.toLowerCase()===oracle.method?.toLowerCase())) copy(`/x-gauntlet-requirement-oracles/${key.replaceAll('~','~0').replaceAll('/','~1')}`);
  }
  const seen = new Set<string>();
  const refs = (v: unknown): string[] => v && typeof v === 'object'
    ? [...(typeof (v as any).$ref === 'string' ? [(v as any).$ref as string] : []), ...Object.values(v).flatMap(refs)] : [];
  while (true) {
    const pending = refs(document).filter(r => r.startsWith('#/') && !seen.has(r));
    if (!pending.length) break;
    for (const ref of pending) { seen.add(ref); copy(ref); }
  }
  return { operations, document, workflows: contract.workflows.filter(w => w.steps.some(s => operationIds.has(s.operationId))) };
}

export function boundedEvidence(value: unknown, maxCharacters = 8000): unknown {
  const sanitized=redactAgentData(value); const text=stableStringify(sanitized,0);
  return text.length <= maxCharacters ? sanitized : { omitted:true,characters:text.length,sha256:sha256(text),preview:text.slice(0,maxCharacters),
    instruction:'Evidence excerpt only. Full value remains in the execution artifact; do not infer omitted content or claim it as proof.' };
}

export function unitIndex(plan: TestPlan) {
  return [...plan.cases.map(c=>({id:c.id,operationIds:[c.operationId],discoveryIds:c.discovery?.candidateIds ?? [],assertions:c.assertions?.length ?? 0})),
    ...plan.workflows.map(w=>({id:w.id,operationIds:[...new Set([...w.steps,...(w.cleanupSteps ?? [])].map(t=>t.operationId))],discoveryIds:[...new Set(w.steps.flatMap(t=>t.discovery?.candidateIds ?? []))],assertions:w.steps.reduce((n,t)=>n+(t.assertions?.length ?? 0),0)}))];
}

export function discoveryContexts(contract: NormalizedContract, documents: Array<{sourceIndex:number;lines:Array<{number:number;text:string}>}>, candidates: DiscoveryCandidate[], config: import('./types.js').GauntletConfig) {
  const system=loadPrompt('discovery');const limit=contextLimits(config.agents).maxInputCharacters;
  const index=candidates.map(c=>({id:c.id,title:c.title,operationId:c.operationId,signal:c.signal,expectedBehavior:(c.scenario as {expectedBehavior?:unknown} | undefined)?.expectedBehavior}));
  const make=(selectedContract:unknown,docs:typeof documents,phase:string,existing=index)=>shareContextSchemas({contract:selectedContract,documents:docs,existingCandidates:existing,
    maxCandidates:config.discovery.maxCandidates-candidates.length,scope:{phase,sourceCount:documents.length,totalOperations:contract.operations.length,
      instruction:'Analyze this bounded slice. Preserve supplied original sourceIndex and line numbers in citations. Do not claim unseen text was read or exhaustive coverage. Other slices are merged and retained by the runtime.'}});
  const fullContract={operations:contract.operations,document:contract.document,workflows:contract.workflows};
  const full=make(fullContract,documents,'complete');
  const sourceLimit=config.discovery.maxAgentInputCharacters ?? 200_000;
  const textSize=(docs:typeof documents)=>docs.reduce((n,d)=>n+d.lines.reduce((m,l)=>m+l.text.length,0),0);
  if(textSize(documents)<=sourceLimit && measureContext('discovery',system,full).totalCharacters<=limit) return [full];
  const result:ReturnType<typeof make>[]=[];
  const fits=(input:ReturnType<typeof make>)=>measureContext('discovery',system,input).totalCharacters<=limit;
  function contractBatch(ids:string[]) {
    const part=make(contractContext(contract,new Set(ids)),[],'contract',index.filter(c=>c.operationId&&ids.includes(c.operationId)));
    if(!fits(part)) {
      if(ids.length===1)throw new Error('DISCOVERY_AGENT_INPUT_LIMIT: one contract operation exceeds the context budget');
      const middle=Math.ceil(ids.length/2);contractBatch(ids.slice(0,middle));contractBatch(ids.slice(middle));return;
    }
    result.push(part);
  }
  for(let i=0;i<contract.operations.length;i+=contextLimits(config.agents).reviewBatchSize) contractBatch(contract.operations.slice(i,i+contextLimits(config.agents).reviewBatchSize).map(o=>o.operationId));
  const catalog={operations:contract.operations.map(o=>({operationId:o.operationId,method:o.method,path:o.path,sourcePointer:o.sourcePointer})),document:{info:contract.document.info},workflows:contract.workflows};
  for(const doc of documents) {
    let lines:typeof doc.lines=[];
    for(const line of doc.lines) {
      const next=[...lines,line];const input=make(catalog,[{sourceIndex:doc.sourceIndex,lines:next}],'document',[]);
      if(textSize([{...doc,lines:next}])>sourceLimit || !fits(input)) {
        if(!lines.length)throw new Error('DISCOVERY_AGENT_INPUT_LIMIT: one source line or operation catalog exceeds the context budget; reformat long single-line documents or narrow the source');
        result.push(make(catalog,[{sourceIndex:doc.sourceIndex,lines}],'document',[]));lines=[];
        const single=make(catalog,[{sourceIndex:doc.sourceIndex,lines:[line]}],'document',[]);
        if(line.text.length>sourceLimit || !fits(single))throw new Error('DISCOVERY_AGENT_INPUT_LIMIT: one source line exceeds the context budget; source was not truncated');
      }
      lines.push(line);
    }
    if(lines.length)result.push(make(catalog,[{sourceIndex:doc.sourceIndex,lines}],'document',[]));
  }
  return result;
}
