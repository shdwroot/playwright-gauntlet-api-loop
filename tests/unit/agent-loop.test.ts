import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../../src/config.js';
import { runAgenticGauntlet } from '../../src/agent-loop.js';
import type { AgentProvider } from '../../src/agents.js';

async function config() {
  const { config } = await loadConfig('gauntlet.offline.config.json');
  const root = await mkdtemp(path.join(tmpdir(), 'gauntlet-agent-policy-'));
  config.generatedDir = path.join(root, 'generated'); config.artifactsDir = path.join(root, 'runs');
  config.agents.provider = 'openai'; config.maxIterations = 1;
  return config;
}

test('lead cannot accept before tests execute and the rejected invocation is retained', async () => {
  const configured = await config();
  const provider: AgentProvider = { async invoke(role, model) {
    return { agentId: `${role}-test`, model, promptHash: 'test', responseHash: 'test', output: role === 'discovery' ? { scenarios: [] } : { action: 'accept', reason: 'Premature acceptance' } };
  } };
  const result = await runAgenticGauntlet(configured, { agentProvider: provider });
  assert.equal(result.status, 'BLOCKED'); assert.equal(result.iterations, 0);
  assert.match(result.findings[0]!.message, /LEAD_ACTION_DENIED/);
  assert.match(await readFile(path.join(result.runDir, 'agents/calls/2-lead-output.json'), 'utf8'), /Premature acceptance/);
});

test('rejected builder proposals are fed back and bounded without any target execution', async () => {
  const configured = await config(); let rejectionSeen = false;
  const provider: AgentProvider = { async invoke(role, model, _system, input) {
    if (role === 'builder' && JSON.stringify(input).includes('PREVIOUS_PROPOSAL_REJECTED')) rejectionSeen = true;
    const output = role === 'discovery' ? { scenarios: [] } : role === 'lead' ? { action: 'build', reason: 'Implement discovered coverage' } : { arbitraryCode: 'not supported' };
    return { agentId: `${role}-test`, model, promptHash: 'test', responseHash: 'test', output };
  } };
  const result = await runAgenticGauntlet(configured, { agentProvider: provider });
  assert.equal(result.status, 'STALLED'); assert.equal(result.iterations, 0); assert.ok(rejectionSeen);
});
