import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requirementCandidates } from '../../src/requirements.js';
import { reconcileCoverage } from '../../src/coverage.js';
import { loadConfig } from '../../src/config.js';
import { loadContract } from '../../src/openapi.js';
import type { DiscoveryReport, DiscoverySourceSnapshot } from '../../src/types.js';
import { addRequirementOracles, explicitStatuses, validOraclePointer } from '../../src/requirement-oracles.js';
import { buildPlan } from '../../src/planner.js';

test('every explicit criterion survives an empty model response and remains a coverage obligation', async () => {
  const { config } = await loadConfig('gauntlet.offline.config.json'); const contract = await loadContract(config.spec);
  const raw = JSON.stringify({ requirements: [
    { id: 'REQ-001', endpoints: ['GET /health'], acceptance_criteria: ['Return 200.', 'Expose the documented health field.'] },
    { id: 'SEC-001', endpoints: ['GET /not-in-contract'], acceptance_criteria: ['Return 403 to unauthorized users.'] },
  ] }, null, 2);
  const source: DiscoverySourceSnapshot = { id:'source',configuredPath:'context',sourcePath:'requirements.json',sourceHash:'hash',bytes:raw.length,kind:'document',parserVersion:'test',status:'parsed',findings:[] };
  const candidates = requirementCandidates(raw,source,contract);
  assert.equal(candidates.length,3); assert.equal(candidates[2]?.operationId,undefined);
  const discovery: DiscoveryReport = {formatVersion:1,specHash:contract.specHash,discoveryHash:'',sourceCount:1,totalBytes:raw.length,sources:[source],candidates,warnings:[],redactionCount:0};
  const backlog = reconcileCoverage(discovery);
  assert.equal(backlog.obligations.length,3); assert.ok(backlog.obligations.every(o => o.status === 'unimplemented'));
  const rediscovered = { ...discovery,candidates:[] };
  assert.equal(reconcileCoverage(rediscovered,backlog).obligations.length,3, 'omitted criteria never silently disappear');
  for (const candidate of candidates) {
    const evidence = candidate.evidence[0]!;
    assert.ok(raw.split('\n')[evidence.lineStart - 1]?.includes(JSON.stringify(evidence.excerpt)));
  }
});

test('requirement oracles add explicit responses and routes without altering OpenAPI expectations', async () => {
  const { config } = await loadConfig('gauntlet.offline.config.json'); const contract = await loadContract(config.spec);
  const first = contract.operations[0]!;
  const raw = JSON.stringify({ requirements: [
    {id:'SEC-1',endpoints:[`${first.method} ${first.path}`],acceptance_criteria:['An unauthorized request returns 403.']},
    {id:'SEC-2',endpoints:['GET /hidden'],acceptance_criteria:['Anonymous callers receive 401 or 403.']},
  ] },null,2);
  const source: DiscoverySourceSnapshot = {id:'source',configuredPath:'context',sourcePath:'requirements.json',sourceHash:'hash',bytes:raw.length,kind:'document',parserVersion:'test',status:'parsed',findings:[]};
  const discovery: DiscoveryReport = {formatVersion:1,specHash:contract.specHash,discoveryHash:'',sourceCount:1,totalBytes:raw.length,sources:[source],candidates:requirementCandidates(raw,source,contract),warnings:[],redactionCount:0};
  const before = JSON.stringify(contract);
  const effective = addRequirementOracles(contract,discovery);
  assert.equal(JSON.stringify(contract),before);
  assert.equal(effective.specHash,contract.specHash);
  for (const original of contract.operations) for (const response of original.responses) assert.deepEqual(effective.operations.find(o=>o.operationId===original.operationId)?.responses.find(r=>r.status===response.status),response);
  const hidden=effective.operations.find(o=>o.path==='/hidden')!;
  assert.deepEqual(hidden.responses.map(r=>r.status),[401,403]);
  assert.ok(hidden.responses.every(r=>r.authority==='requirement'));
  assert.ok(validOraclePointer(effective,'requirement',hidden.responses[0]!.sourcePointer));
  assert.equal(validOraclePointer(effective,'openapi',hidden.responses[0]!.sourcePointer),false);
  assert.equal(validOraclePointer(effective,'requirement','/x-gauntlet-requirement-oracles/fabricated'),false);
  assert.deepEqual(explicitStatuses('The discount is 20 percent and the maximum length is 200.'),[]);
  assert.deepEqual(explicitStatuses('Unknown callers return 401; forbidden with 401 or 403.'),[401,403]);
  const baseline = buildPlan(effective,config,discovery);
  assert.ok(!baseline.cases.some(c=>c.operationId===hidden.operationId),'requirement-only routes need requirement-specific agent tests');
  assert.deepEqual(baseline.cases.map(c=>c.id),buildPlan(contract,config).cases.map(c=>c.id),'supplemental responses never invent new generic baseline cases');
});
