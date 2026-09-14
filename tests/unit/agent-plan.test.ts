import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../../src/config.js';
import { loadContract } from '../../src/openapi.js';
import { buildPlan } from '../../src/planner.js';
import { applyAgentPlan, applyAgentPlanIncrementally } from '../../src/agent-plan.js';
import { discoverScenarios } from '../../src/discovery.js';
import { redactAgentData } from '../../src/agent-redaction.js';
import type { AgentProvider } from '../../src/agents.js';
import { compactFindings, coverageWorklist } from '../../src/agents.js';

async function base() {
  const { config } = await loadConfig('gauntlet.offline.config.json');
  const contract = await loadContract(config.spec);
  return { config, contract, plan: buildPlan(contract, config) };
}

test('coverage worklists retain unlinked requirements and compact duplicated diagnostic evidence', async () => {
  const {plan} = await base();
  plan.discovery = {formatVersion:1,specHash:plan.specHash,discoveryHash:'',sourceCount:0,totalBytes:0,sources:[],warnings:[],redactionCount:0,
    candidates:Array.from({length:15},(_,i)=>({id:`req-${i}`,origin:'requirement',signal:'semantic-scenario',operationId:'listUsers',confidence:1,disposition:'report-only',reason:'Check this criterion',contractPointers:[],evidence:[]}))};
  assert.equal(coverageWorklist(plan,0.85).remaining,15);
  assert.equal(coverageWorklist(plan,0.85).batch.length,12);
  plan.cases[0]!.discovery = {signal:'semantic-scenario',candidateIds:['req-0'],evidence:[]};
  assert.equal(coverageWorklist(plan,0.85).remaining,14);
  assert.ok(!coverageWorklist(plan,0.85).batch.some(c=>c.id==='req-0'));
  const compact = compactFindings([{code:'SEMANTIC_COVERAGE_GAP',severity:'blocking',message:'req-1 needs a linked exact assertion',evidence:['attempts/1/verification.json','x'.repeat(500_000)]}]);
  assert.equal(compact[0]!.message,'req-1 needs a linked exact assertion');
  assert.deepEqual(compact[0]!.evidence,['attempts/1/verification.json']);
  assert.equal(compact[0]!.evidenceOmitted,1);
  assert.ok(JSON.stringify(compact).length<1000);
});
const testCase = { id: 'last-page', title: 'Empty last page', operationId: 'listUsers', status: 200,
  rationale: 'A valid offset beyond available users returns an empty page.', assertions: [{ path: '$.data', operator: 'length-equals', value: 0, sourcePointer: '/paths/~1users/get' }], request: { query: { limit: 1, offset: 10000 } } };

test('exact JSON comparisons compile without changing semantics and malformed assertions never execute', async () => {
  const { config, contract, plan } = await base();
  const candidate = { ...testCase, assertions: [{path:'$',operator:'json-equals',value:'{"data":[],"offset":0}',sourcePointer:'/paths/~1users/get'}] };
  const built = applyAgentPlan(plan, {cases:[candidate]}, contract, config);
  assert.deepEqual(built.cases.at(-1)?.assertions?.[0]?.value, {data:[],offset:0});
  assert.equal(built.cases.at(-1)?.assertions?.[0]?.operator, 'equals');
  for (const value of ['{invalid','42','null','"serialized"']) {
    assert.throws(() => applyAgentPlan(plan,{cases:[{...candidate,assertions:[{...candidate.assertions[0],value}]}]},contract,config),/AGENT_ASSERTION_VALUE_INVALID/);
  }
  assert.throws(() => applyAgentPlan(plan,{cases:[{...candidate,assertions:[{...candidate.assertions[0],operator:'not-exists'}]}]},contract,config),/AGENT_ASSERTION_TYPE_INVALID/);
  config.fixtures = {adapter:'dvra',command:['unused']};
  assert.throws(() => applyAgentPlan(plan,{cases:[{...candidate,assertions:[{path:'$.actors.customerB.coupons',target:'fixture',operator:'length-equals',value:1,sourcePointer:'/paths/~1users/get'}]}]},contract,config),/fixture counts are numeric/);
});

test('agent authors executable inputs; repairs preserve immutable expectations and baseline cases', async () => {
  const { config, contract, plan } = await base();
  const built = applyAgentPlan(plan, { cases: [testCase] }, contract, config);
  const added = built.cases.find((item) => item.id === 'agent-last-page')!;
  assert.deepEqual(added.query, { limit: 1, offset: 10000 });
  assert.ok(added.expected.schema);
  assert.deepEqual(built.cases.slice(0, plan.cases.length), plan.cases);
  const repaired = applyAgentPlan(built, { repairs: [{ caseId: added.id, rationale: 'Fix offset setup', request: { query: { limit: 1, offset: 9999 } } }] }, contract, config, true);
  assert.deepEqual(repaired.cases.at(-1)?.expected, added.expected);
  assert.deepEqual(repaired.cases.at(-1)?.assertions, added.assertions);
  assert.throws(() => applyAgentPlan(built, { repairs: [{ caseId: added.id, rationale: 'Hide failure', request: { expected: { statuses: [400] } } }] }, contract, config, true), /unsupported request/);
  const baselineRepair = applyAgentPlan(built, { repairs: [{ caseId: plan.cases[0]!.id, rationale: 'Repair generated request data', request: {} }] }, contract, config, true);
  assert.deepEqual(baselineRepair.cases[0], plan.cases[0], 'an empty request repair must not manufacture executable progress');
  assert.throws(() => applyAgentPlan(built, { repairs: [{ caseId: 'unknown', rationale: 'Unknown case', request: {} }] }, contract, config, true), /AGENT_REPAIR_DENIED/);
});

test('agent proposals cannot invent operations, statuses, headers or skip controls', async () => {
  const { config, contract, plan } = await base();
  for (const change of [{ operationId: 'unknown' }, { status: 599 }, { skip: true }, { request: { headers: { host: 'example.org' } } }]) {
    assert.throws(() => applyAgentPlan(plan, { cases: [{ ...testCase, ...change }] }, contract, config), /AGENT_/);
  }
  assert.throws(() => applyAgentPlan(plan, { cases: [testCase] }, contract, { ...config, safety: { ...config.safety, maxRequestsPerRun: 1 } }), /BUDGET/);
});

test('independent valid proposals survive rejection while invalid workflows remain atomic',async()=>{
  const {config,contract,plan}=await base();
  assert.throws(()=>applyAgentPlan({...plan,specHash:'different-contract'},{cases:[testCase]},contract,config),/CONTRACT_MISMATCH/);
  const result=applyAgentPlanIncrementally(plan,{cases:[testCase,{...testCase,id:'bad',operationId:'invented'}],workflows:[{id:'bad-workflow',title:'Invalid second step',steps:[{...testCase,id:'first'},{...testCase,id:'second',status:599}]}]},contract,config);
  assert.equal(result.plan.cases.length,plan.cases.length+1);
  assert.equal(result.plan.workflows.length,plan.workflows.length);
  assert.equal(result.rejections.length,2);
  assert.deepEqual(result.plan.cases.slice(0,plan.cases.length),plan.cases);
  assert.throws(()=>applyAgentPlanIncrementally(plan,{skip:true},contract,config),/unsupported plan/);
});

test('a workflow link includes its declared cleanup operation without inventing coverage',async()=>{
  const {config,contract,plan}=await base();
  plan.discovery={formatVersion:1,specHash:plan.specHash,discoveryHash:'',sourceCount:0,totalBytes:0,sources:[],warnings:[],redactionCount:0,candidates:[{id:'delete-criterion',origin:'requirement',signal:'semantic-scenario',confidence:1,disposition:'report-only',operationId:'deleteUser',reason:'Delete returns 204',contractPointers:[],evidence:[]}]};
  const result=applyAgentPlan(plan,{workflows:[{id:'cleanup-proof',title:'Read and delete',steps:[testCase],cleanupSteps:[{id:'delete',operationId:'deleteUser',status:204,rationale:'Delete fixture user',request:{pathParams:{id:'owned-id'}}}]}],coverageLinks:[{caseId:'cleanup-proof',discoveryIds:['delete-criterion'],rationale:'Cleanup performs the asserted delete operation'}]},contract,config);
  assert.ok(result.workflows.at(-1)?.cleanupSteps?.[0]?.discovery?.candidateIds.includes('delete-criterion'));
  assert.ok(result.operations.find(o=>o.operationId==='deleteUser')?.coveredBy.includes('workflow:agent-cleanup-proof'));
});

test('declared non-auth 4xx scenarios use synthetic invalid credentials without sending model literals', async () => {
  const {config,contract,plan}=await base();
  const operation=contract.operations.find(o=>o.responses.some(r=>r.status===400))!;
  assert.ok(operation);
  const candidate={id:'unexpected-header',operationId:operation.operationId,status:400,rationale:'Declared rejection with an Authorization header',request:{useAuth:false,headers:{authorization:'Bearer model-literal'}}};
  const built=applyAgentPlan(plan,{cases:[candidate]},contract,config);
  assert.equal(built.cases.at(-1)?.headers.authorization,'Bearer gauntlet-invalid-credential');
  assert.deepEqual(built.cases.at(-1)?.expected.statuses,[400]);
  assert.throws(()=>applyAgentPlan(plan,{cases:[{...candidate,status:200}]},contract,config),/HEADER_DENIED/);
});

test('existing executable cases can receive validated scenario links without duplicate requests', async () => {
  const { config, contract, plan } = await base();
  const target = plan.cases.find(item => item.operationId === 'listUsers' && item.kind === 'authorization')!;
  plan.discovery = { formatVersion: 1, specHash: contract.specHash, discoveryHash: '', sourceCount: 0,
    totalBytes: 0, sources: [], warnings: [], redactionCount: 0, candidates: [{
      id: 'auth-scenario', signal: 'semantic-scenario', origin: 'llm', operationId: 'listUsers',
      confidence: 0.99, disposition: 'report-only', reason: 'Needs a test link', contractPointers: [], evidence: [],
    }] };
  const output = { coverageLinks: [{ caseId: target.id, discoveryIds: ['auth-scenario'], rationale: 'Existing case omits auth and expects the declared unauthorized response.' }] };
  const linked = applyAgentPlan(plan, output, contract, config);
  assert.equal(linked.cases.length, plan.cases.length);
  assert.deepEqual(linked.cases.find(item => item.id === target.id)?.expected, target.expected);
  assert.deepEqual(linked.cases.find(item => item.id === target.id)?.discovery?.candidateIds, ['auth-scenario']);
  assert.deepEqual(applyAgentPlan(linked, output, contract, config), linked, 'repeated links are not artificial progress');
  assert.throws(() => applyAgentPlan(plan, { coverageLinks: [{ ...output.coverageLinks[0], discoveryIds: ['unknown'] }] }, contract, config), /DISCOVERY_REFERENCE_INVALID/);
  const unrelated = plan.cases.find(item => item.operationId === 'getHealth')!;
  assert.throws(() => applyAgentPlan(plan, { coverageLinks: [{ ...output.coverageLinks[0], caseId: unrelated.id }] }, contract, config), /DISCOVERY_REFERENCE_INVALID/);
  const workflow = { id: 'auth-checks', title: 'Repeated unauthenticated listing', steps: [
    { id: 'first', operationId: 'listUsers', status: 401, request: { useAuth: false }, capture: { whole: '$' } },
    { id: 'second', operationId: 'listUsers', status: 401, request: { useAuth: false }, assertions: [{ path: '$', operator: 'equals', value: '${whole}', sourcePointer: '/paths/~1users/get' }] },
  ] };
  const withWorkflow = applyAgentPlan(plan, { workflows: [workflow], coverageLinks: [{ ...output.coverageLinks[0], caseId: 'auth-checks' }] }, contract, config);
  assert.ok(withWorkflow.workflows.at(-1)?.steps.every(step => step.discovery?.candidateIds.includes('auth-scenario')));
  assert.equal(withWorkflow.workflows.at(-1)?.steps[0]?.capture.whole, '$');
});

test('agent workflows validate capture references and account for every request', async () => {
  const { config, contract, plan } = await base();
  const workflow = { id: 'page-roundtrip', title: 'Read using captured offset', steps: [
    { ...testCase, id: 'capture-page', capture: { nextOffset: '$.offset' } },
    { ...testCase, id: 'read-page', request: { query: { limit: 1, offset: '${nextOffset}' } } },
  ] };
  const built = applyAgentPlan(plan, { workflows: [workflow] }, contract, config);
  assert.equal(built.workflows.at(-1)?.steps.length, 2);
  workflow.steps[1]!.request = { query: { limit: 1, offset: '${unknown}' } };
  assert.throws(() => applyAgentPlan(plan, { workflows: [workflow] }, contract, config), /CAPTURE_UNBOUND/);
});

test('semantic discovery calls a provider with complete redacted prose and rejects fabricated citations', async () => {
  const { config, contract } = await base();
  config.agents.provider = 'openai';
  let calls = 0;
  const provider: AgentProvider = { async invoke(role, model, _system, input) {
    calls++;
    assert.equal(role, 'discovery');
    const serialized = JSON.stringify(input);
    assert.doesNotMatch(serialized, /sample-super-secret|private@example.test/);
    assert.match(serialized, /documents/);
    return { agentId: 'test-discovery', model, promptHash: 'test', responseHash: 'test', output: { scenarios: [{
      title: 'Semantic edge', rationale: 'Cross-field behavior in supplied prose', operationId: 'listUsers', confidence: 0.95,
      scenario: { steps: ['Use a large valid offset with the smallest page size'] }, citations: [{ sourceIndex: 0, lineStart: 999999, lineEnd: 999999 }],
    }] } };
  } };
  await assert.rejects(discoverScenarios(contract, config, provider), /CITATION_INVALID/);
  assert.equal(calls, 1);
  await assert.rejects(discoverScenarios(contract, { ...config, discovery: { ...config.discovery, maxAgentInputCharacters: 1 } }, provider), /INPUT_LIMIT/);
  assert.equal(calls, 1, 'budget rejection occurs before the provider call');
});

test('agent redaction preserves citation identifiers while removing multiline private keys', () => {
  const output = redactAgentData({ sourceId: 'scenario-guidance:123456789012', text: '-----BEGIN PRIVATE KEY-----\nprivate-secret-material\n-----END PRIVATE KEY-----\nAuthorization: Bearer my-secret' });
  assert.doesNotMatch(JSON.stringify(output), /private-secret-material|my-secret/);
  assert.match(JSON.stringify(output), /scenario-guidance:123456789012/);
});

test('contract-only agent discovery still calls the model when local source discovery is disabled', async () => {
  const { config, contract } = await base();
  config.agents.provider = 'openai'; config.discovery.enabled = false;
  let called = false;
  const provider: AgentProvider = { async invoke(_role, model, _system, input) {
    called = true;
    assert.deepEqual((input as { documents: unknown[] }).documents, []);
    return { agentId: 'contract-analysis', model, promptHash: 'test', responseHash: 'test', output: { scenarios: [] } };
  } };
  const report = await discoverScenarios(contract, config, provider);
  assert.ok(called);
  assert.equal(report.analysis?.mode, 'llm');
});

test('model failure never silently falls back to deterministic discovery', async () => {
  const { config, contract } = await base(); config.agents.provider = 'openai';
  const provider: AgentProvider = { async invoke() { throw new Error('MODEL_UNAVAILABLE'); } };
  await assert.rejects(discoverScenarios(contract, config, provider), /MODEL_UNAVAILABLE/);
});

test('healer can establish setup before an existing test without dropping it or changing assertions', async () => {
  const { config, contract, plan } = await base();
  const built = applyAgentPlan(plan, { cases: [testCase] }, contract, config);
  const original = built.cases.find((item) => item.id === 'agent-last-page')!;
  const fixed = applyAgentPlan(built, { repairs: [{ caseId: original.id, request: {}, rationale: 'Establish fixture state before the existing scenario.', setupSteps: [
    { id: 'reset-before-page', title: 'Reset fixture', operationId: 'resetFixture', status: 200, rationale: 'Prepare deterministic state', request: { headers: { 'x-gauntlet-reset': 'allowed' } } },
  ] }] }, contract, config, true);
  const relocated = fixed.workflows.flatMap((item) => item.steps).find((item) => item.id === original.id)!;
  assert.deepEqual(relocated.expected, original.expected);
  assert.deepEqual(relocated.assertions, original.assertions);
  assert.deepEqual(relocated.query, original.query);
  assert.equal(fixed.cases.length + fixed.workflows.length, built.cases.length + built.workflows.length);
  assert.equal(fixed.workflows.at(-1)?.steps[0]?.operationId, 'resetFixture');
});

test('invalid authentication tests use synthetic credentials without exposing or accepting a supplied key', async () => {
  const { config, contract, plan } = await base();
  const built = applyAgentPlan(plan, { cases: [{ ...testCase, id: 'invalid-credential', status: 401, assertions: [], request: { useAuth: false, headers: { 'x-api-key': 'dummy-proposed-value' } } }] }, contract, config);
  assert.equal(built.cases.at(-1)?.headers['x-api-key'], 'gauntlet-invalid-credential');
  assert.equal(built.cases.at(-1)?.useAuth, false);
  assert.throws(() => applyAgentPlan(plan, { cases: [{ ...testCase, request: { useAuth: true, headers: { 'x-api-key': 'dummy-proposed-value' } } }] }, contract, config), /HEADER_DENIED/);
});

test('assertions can cite referenced components and use array indices', async () => {
  const { config, contract, plan } = await base();
  const built = applyAgentPlan(plan, { cases: [{ ...testCase, assertions: [{ path: '$.data[0].id', operator: 'equals', value: 'usr_0001', sourcePointer: '#/components/schemas/User/properties/id' }] }] }, contract, config);
  assert.equal(built.cases.at(-1)?.assertions?.[0]?.path, '$.data.0.id');
  assert.throws(() => applyAgentPlan(plan, { cases: [{ ...testCase, assertions: [{ path: '$.data', operator: 'length-equals', value: 1, sourcePointer: '/components/responses/ResetForbidden' }] }] }, contract, config), /PROVENANCE_INVALID/);
});

test('assertion improvements append without weakening expectations and reject unbound captures', async () => {
  const { config, contract, plan } = await base();
  const built = applyAgentPlan(plan, { cases: [testCase] }, contract, config);
  const target = built.cases.at(-1)!;
  const addition = { path: '$.total', operator: 'gte', value: 0, sourcePointer: '/paths/~1users/get' };
  const enhanced = applyAgentPlan(built, { assertionAdditions: [{ caseId: target.id, assertions: [addition] }] }, contract, config);
  assert.deepEqual(enhanced.cases.at(-1)?.expected, target.expected);
  assert.deepEqual(enhanced.cases.at(-1)?.assertions?.[0], target.assertions?.[0]);
  assert.equal(enhanced.cases.at(-1)?.assertions?.length, 2);
  assert.throws(() => applyAgentPlan(built, { assertionAdditions: [{ caseId: target.id, assertions: [{ ...addition, value: '${unknown}' }] }] }, contract, config), /CAPTURE_UNBOUND/);
});
