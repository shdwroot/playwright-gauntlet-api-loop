import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reconcileCoverage, verifyCoverage } from '../../src/coverage.js';
import { loadConfig } from '../../src/config.js';
import { loadContract } from '../../src/openapi.js';
import { buildPlan } from '../../src/planner.js';
import type { DiscoveryReport, ExecutionSummary } from '../../src/types.js';
import type { AgentProvider } from '../../src/agents.js';

function discovery(): DiscoveryReport { return { formatVersion: 1, specHash: 'a', discoveryHash: '', sourceCount: 0, totalBytes: 0, sources: [], warnings: [], redactionCount: 0,
  candidates: [{ id: 'semantic-1', origin: 'llm', signal: 'semantic-scenario', confidence: 1, disposition: 'report-only', reason: '', evidence: [], contractPointers: [] }] }; }

test('backlog retains omitted discoveries and never carries verification across runs or source changes', () => {
  const old = reconcileCoverage(discovery()); old.obligations[0]!.status = 'verified';
  const fresh = discovery(); fresh.candidates = [];
  assert.equal(reconcileCoverage(fresh, old).obligations[0]!.status, 'unimplemented');
  const changed = discovery(); changed.candidates = []; changed.specHash = 'b';
  const stale = reconcileCoverage(changed, old);
  assert.equal(stale.obligations[0]!.status, 'needs-review');
  assert.equal(reconcileCoverage(changed, stale).obligations[0]!.status, 'needs-review');
});

test('semantic gate rejects invented assertions, missing execution, missing review, and model-approved failures', async () => {
  const { config } = await loadConfig('gauntlet.offline.config.json');
  config.quality.requireSemanticVerification = true;
  const plan = buildPlan(await loadContract(config.spec), config);
  const t = plan.cases[0]!;
  t.discovery = { signal: 'semantic-scenario', candidateIds: ['semantic-1'], evidence: [] };
  const execution = { observations: [{ title: `[${t.id}] test`, status: 'passed', exchanges: [] }] } as unknown as ExecutionSummary;
  let pointer = '/expected/statuses';
  let omit = false;
  const provider: AgentProvider = { async invoke() { return { agentId: 'test', model: 'test', promptHash: '', responseHash: '', output: { assessments: omit ? [] : [{ obligationId: 'semantic-1', verdict: 'verified', reason: 'Status scenario', proofs: [{ testId: t.id, assertionPointers: [pointer] }] }] } }; } };
  assert.equal((await verifyCoverage(provider, config, plan, execution, reconcileCoverage(discovery()))).findings.length, 0);
  pointer = '/assertions/999';
  assert.equal((await verifyCoverage(provider, config, plan, execution, reconcileCoverage(discovery()))).findings[0]?.code, 'SEMANTIC_COVERAGE_GAP');
  t.expected.schema = { type: 'object', description: 'Metadata is not an executable assertion' };
  pointer = '/expected/schema/description';
  assert.equal((await verifyCoverage(provider, config, plan, execution, reconcileCoverage(discovery()))).findings.length, 1);
  pointer = '/expected/statuses'; execution.observations![0]!.title = `[other] spoof [${t.id}] test`;
  assert.equal((await verifyCoverage(provider, config, plan, execution, reconcileCoverage(discovery()))).findings.length, 1);
  execution.observations![0]!.title = `[${t.id}] test`; execution.observations![0]!.status = 'failed';
  assert.equal((await verifyCoverage(provider, config, plan, execution, reconcileCoverage(discovery()))).findings.length, 1);
  execution.observations = []; omit = true;
  assert.equal((await verifyCoverage(provider, config, plan, execution, reconcileCoverage(discovery()))).findings.length, 1);
});

test('changed obligations require a reviewed mapping to freshly verified replacements', async () => {
  const { config } = await loadConfig('gauntlet.offline.config.json'); config.quality.requireSemanticVerification = true;
  const plan = buildPlan(await loadContract(config.spec), config); const t = plan.cases[0]!;
  const old = reconcileCoverage(discovery());
  const current = discovery(); current.specHash = 'changed'; current.candidates[0]!.id = 'replacement';
  t.discovery = { signal: 'semantic-scenario', candidateIds: ['replacement'], evidence: [] };
  let replacement = 'invented';
  const provider: AgentProvider = { async invoke() { return { agentId: 'test', model: 'test', promptHash: '', responseHash: '', output: {
    assessments: [{ obligationId: 'replacement', verdict: 'verified', reason: 'Preserves status check', proofs: [{ testId: t.id, assertionPointers: ['/expected/statuses'] }] }],
    reconciliations: [{ obligationId: 'semantic-1', replacementIds: [replacement], reason: 'Same behavior preserved in updated requirement' }],
  } }; } };
  const execution = { observations: [{ title: `[${t.id}] test`, status: 'passed', exchanges: [] }] } as unknown as ExecutionSummary;
  assert.equal((await verifyCoverage(provider, config, plan, execution, reconcileCoverage(structuredClone(current), old))).findings.length, 1);
  replacement = 'replacement'; const backlog = reconcileCoverage(structuredClone(current), old);
  assert.equal((await verifyCoverage(provider, config, plan, execution, backlog)).findings.length, 0);
  assert.deepEqual(backlog.obligations.find(o => o.id === 'semantic-1')?.replacedBy, ['replacement']);
});

test('rediscovery cannot lower confidence or reject an outstanding obligation to bypass coverage', () => {
  const previous = reconcileCoverage(discovery());
  const fresh = discovery(); fresh.candidates[0]!.confidence = 0.1; fresh.candidates[0]!.disposition = 'reject';
  const backlog = reconcileCoverage(fresh, previous);
  assert.equal(backlog.obligations.length, 1);
  assert.equal(backlog.obligations[0]?.candidate.confidence, 1);
  assert.notEqual(backlog.obligations[0]?.candidate.disposition, 'reject');
});

test('verifier transport requires one keyed review per obligation and decodes keys into exact IDs', async () => {
  const { agentOutputSchema, decodeAgentOutput } = await import('../../src/agent-protocol.js');
  const schema = agentOutputSchema('verifier', { obligations: [{ id: 'one' }, { id: 'two' }], plan: { cases: [{ id: 'case-a' }], workflows: [] } }) as any;
  assert.deepEqual(schema.properties.assessments.required, ['one', 'two']);
  assert.equal(schema.properties.assessments.additionalProperties, false);
  const decoded = decodeAgentOutput({ assessments: { one: { verdict: 'gap', reason: 'missing', proofs: [] } }, isolation: { 'case-a': { verdict: 'isolated', reason: 'stateless' } } }) as any;
  assert.equal(decoded.assessments[0].obligationId, 'one');
  assert.equal(decoded.isolation[0].unitId, 'case-a');
});
