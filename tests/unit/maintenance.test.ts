import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../../src/config.js';
import { contextChanges, maintainRun, snapshotContext, watchRevisions, withRunLock } from '../../src/maintenance.js';
import { writeAnalysisReport } from '../../src/analysis-report.js';
import type { RunResult } from '../../src/types.js';
import { loadContract } from '../../src/openapi.js';
import { buildPlan } from '../../src/planner.js';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'gauntlet-maintenance-'));
  const { config } = await loadConfig('gauntlet.offline.config.json');
  config.projectRoot = root; config.spec = path.join(root, 'spec.yaml');
  config.generatedDir = path.join(root, 'generated'); config.artifactsDir = path.join(root, 'runs');
  config.discovery.sources = [{ id: 'context', path: path.join(root, 'context'), kind: 'document' }];
  await mkdir(path.join(root, 'context')); await writeFile(config.spec, 'openapi: 3.0.0');
  await writeFile(path.join(root, 'context/rules.md'), 'Rule A');
  return config;
}

function result(runDir: string, runId = 'run-one'): RunResult {
  return { runDir, runId, status: 'PASSED', iterations: 0, finalScore: 100, findings: [], events: [], heals: [] };
}

test('context revisions detect content changes and newly added files, ignoring unrelated artifacts', async () => {
  const config = await fixture(); const first = await snapshotContext(config);
  await writeFile(path.join(config.projectRoot, 'unrelated.txt'), 'not context');
  assert.equal((await snapshotContext(config)).revision, first.revision);
  await writeFile(path.join(config.projectRoot, 'context/rules.md'), 'Rule B');
  await writeFile(path.join(config.projectRoot, 'context/new.md'), 'Rule C');
  const next = await snapshotContext(config);
  assert.notEqual(next.revision, first.revision);
  assert.deepEqual(contextChanges(first, next), { added: ['context/new.md'], changed: ['context/rules.md'], removed: [] });
});

test('run lock rejects concurrent writers and releases after a failed run', async () => {
  const config = await fixture();
  await assert.rejects(withRunLock(config.generatedDir, async () => {
    await assert.rejects(withRunLock(config.generatedDir, async () => {}), /RUN_ALREADY_ACTIVE/);
    throw new Error('intentional failure');
  }), /intentional failure/);
  await withRunLock(config.generatedDir, async () => {});
});

test('mid-run context drift invalidates a pass and preserves revision history across invocations', async () => {
  const config = await fixture();
  const first = await maintainRun(config, undefined, async () => {
    await writeFile(path.join(config.projectRoot, 'context/rules.md'), 'Changed while running');
    return result(path.join(config.artifactsDir, 'run-one'));
  });
  assert.equal(first.status, 'BLOCKED');
  assert.equal(first.findings[0]?.code, 'CONTEXT_CHANGED_DURING_RUN');
  const second = await maintainRun(config, undefined, async () => result(path.join(config.artifactsDir, 'run-two'), 'run-two'));
  const metadata = JSON.parse(await readFile(path.join(second.runDir, 'context.json'), 'utf8'));
  assert.equal(metadata.previousRunId, 'run-one'); assert.equal(metadata.stableDuringRun, true);
  assert.deepEqual(metadata.changes.changed, ['context/rules.md']);
  assert.match(await readFile(path.join(first.runDir, 'analysis.md'), 'utf8'), /CONTEXT_CHANGED_DURING_RUN/);
});

test('watch coalesces changes during execution and serializes the next full run', async () => {
  const controller = new AbortController(); let revision = 'one'; let active = 0; let count = 0;
  await watchRevisions({ signal: controller.signal, intervalMs: 1, revision: async () => revision,
    execute: async () => {
      assert.equal(active++, 0); count++;
      if (count === 1) revision = 'two'; else controller.abort();
      await new Promise(resolve => setTimeout(resolve, 5)); active--;
    } });
  assert.equal(count, 2);
});

test('watch does not retry an unchanged failing revision indefinitely', async () => {
  const controller = new AbortController(); let count = 0; let scans = 0;
  await watchRevisions({ signal: controller.signal, intervalMs: 1,
    revision: async () => { if (++scans === 4) controller.abort(); return 'one'; },
    execute: async () => { count++; throw new Error('provider failed'); } });
  assert.equal(count, 1);
});

test('stopping watch during a context scan does not start a new run', async () => {
  const controller = new AbortController(); let count = 0;
  await watchRevisions({ signal: controller.signal,
    revision: async () => { controller.abort(); return 'one'; },
    execute: async () => { count++; } });
  assert.equal(count, 0);
});

test('analysis retains earlier failures after final findings have been cleared', async () => {
  const config = await fixture(); const run = result(path.join(config.artifactsDir, 'report'));
  run.iterations = 2;
  await mkdir(path.join(run.runDir, 'attempts/1'), { recursive: true });
  await writeFile(path.join(run.runDir, 'attempts/1/critic.json'), JSON.stringify({ findings: [{ code: 'EARLIER_FAILURE', severity: 'blocking', message: 'Original failure' }] }));
  await writeAnalysisReport(run);
  assert.match(await readFile(path.join(run.runDir, 'analysis.md'), 'utf8'), /EARLIER_FAILURE/);
});

test('validated plans survive restart but are not reused after a context change', async () => {
  const config = await fixture();
  config.agents.provider = 'openai';
  const original = await loadConfig('gauntlet.offline.config.json');
  const plan = buildPlan(await loadContract(original.config.spec), original.config);
  plan.cases[0]!.query = { maintained: 'validated repair' };
  await maintainRun(config, undefined, async () => {
    const run = result(path.join(config.artifactsDir, 'saved'), 'saved');
    await mkdir(run.runDir, { recursive: true });
    await writeFile(path.join(run.runDir, 'plan.json'), JSON.stringify(plan));
    return run;
  });
  await maintainRun(config, undefined, async prior => {
    assert.deepEqual(prior?.cases[0]?.query, { maintained: 'validated repair' });
    return result(path.join(config.artifactsDir, 'restarted'), 'restarted');
  });
  const resumed = JSON.parse(await readFile(path.join(config.artifactsDir,'restarted','context.json'),'utf8'));
  assert.equal(resumed.reusedValidatedPlan,true);
  assert.equal(resumed.resumedCandidatePlan,false);
  await writeFile(path.join(config.projectRoot, 'context/rules.md'), 'New expectation');
  await maintainRun(config, undefined, async prior => {
    assert.equal(prior, undefined);
    return result(path.join(config.artifactsDir, 'changed'), 'changed');
  });
});

test('failed runs retain candidate work without certifying it and reject tampered checkpoints', async () => {
  const config = await fixture(); config.agents.provider = 'openai';
  const original = await loadConfig('gauntlet.offline.config.json');
  const plan = buildPlan(await loadContract(original.config.spec), original.config);
  await maintainRun(config, undefined, async () => {
    const run = result(path.join(config.artifactsDir, 'failed'), 'failed'); run.status = 'FAILED';
    await mkdir(run.runDir, { recursive: true });
    await writeFile(path.join(run.runDir, 'plan.json'), JSON.stringify(plan));
    return run;
  });
  const runDir = path.join(config.artifactsDir, 'resume');
  await maintainRun(config, undefined, async prior => {
    assert.deepEqual(prior, plan);
    const run = result(runDir, 'resume'); run.status = 'FAILED'; return run;
  });
  const metadata = JSON.parse(await readFile(path.join(runDir, 'context.json'), 'utf8'));
  assert.equal(metadata.resumedCandidatePlan, true);
  assert.equal(metadata.reusedValidatedPlan, false);
  const { readdir } = await import('node:fs/promises');
  const maintenance = path.join(config.artifactsDir, '.maintenance');
  const stateDir = path.join(maintenance, (await readdir(maintenance))[0]!);
  await assert.rejects(readFile(path.join(stateDir, 'validated-plan.json')), /ENOENT/);
  const checkpointPath = path.join(stateDir, 'candidate-plan.json');
  const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8'));
  checkpoint.plan.seed = 999;
  await writeFile(checkpointPath, JSON.stringify(checkpoint));
  await assert.rejects(maintainRun(config, undefined, async () => result(runDir)), /PERSISTED_PLAN_INTEGRITY_FAILED/);
});
