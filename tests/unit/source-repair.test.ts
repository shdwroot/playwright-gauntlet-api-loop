import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applySourceEdits, repairSource, sourceFiles } from '../../src/source-repair.js';
import { loadConfig } from '../../src/config.js';
import { loadContract } from '../../src/openapi.js';
import { buildPlan } from '../../src/planner.js';
import type { ExecutionSummary } from '../../src/types.js';
import type { AgentProvider } from '../../src/agents.js';

test('source edits reject stale state and never partially apply an invalid proposal', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gauntlet-source-'));
  try {
    await mkdir(path.join(root, 'app')); await writeFile(path.join(root, 'app/service.js'), 'export const status = 500;\n');
    const config = { root, include: ['app'], verifyCommand: ['node','--check','app/service.js'], restartCommand: ['node','-e','process.exit(0)'], maxAttempts: 3, commandTimeoutMs: 10000 };
    const original = await sourceFiles(config);
    const edit = { path: 'app/service.js', oldText: '500', newText: '200' };
    await assert.rejects(applySourceEdits(config, original, [edit, { ...edit, path: '../escape.js' }], path.join(root,'evidence')), /FILE_DENIED/);
    assert.equal(await readFile(path.join(root,edit.path),'utf8'), original[edit.path]);
    await writeFile(path.join(root, edit.path), 'export const status = 503;\n');
    await assert.rejects(applySourceEdits(config, original, [edit], path.join(root,'evidence')), /CONCURRENT_EDIT/);
    await writeFile(path.join(root,edit.path),original[edit.path]!);
    await assert.rejects(applySourceEdits(config,original,[edit,{path:edit.path,oldText:'= 500',newText:'= 201'}],path.join(root,'overlap')),/OVERLAPPING_EDITS/);
    const changed=await applySourceEdits(config,original,[edit,{path:edit.path,oldText:'const status',newText:'let status'}],path.join(root,'multiple'));
    assert.equal(Object.keys(changed.after).length,1);
    assert.equal(await readFile(path.join(root,edit.path),'utf8'),'export let status = 200;\n');
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('developer patches are rolled back when source validation fails and logged when accepted', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gauntlet-developer-'));
  try {
    await mkdir(path.join(root,'app')); await writeFile(path.join(root,'app/service.js'),'const status = 500;\n');
    const { config } = await loadConfig('gauntlet.offline.config.json');
    config.sourceRepair = { root, include: ['app'], verifyCommand: [process.execPath,'--check','app/service.js'], restartCommand: [process.execPath,'-e','process.exit(0)'], maxAttempts: 3, commandTimeoutMs: 10000 };
    const contract = await loadContract(config.spec); const plan = buildPlan(contract,config);
    let replacement = '!!!';
    // Scripted provider is only a test double for patch validation, never runtime fallback.
    const provider: AgentProvider = { async invoke(role, model) { assert.equal(role,'developer'); return { agentId:'test',model,promptHash:'test',responseHash:'test',output:{hypothesis:'Status handling defect',edits:[{path:'app/service.js',oldText:'500',newText:replacement}]}}; } };
    const execution = { status:'test-failed', failures:[] } as unknown as ExecutionSummary;
    const failed = await repairSource(provider,config,contract,plan,execution,1,path.join(root,'failed'));
    assert.equal(failed.rollback,true); assert.equal(failed.policyDecision,'denied');
    assert.equal(await readFile(path.join(root,'app/service.js'),'utf8'),'const status = 500;\n');
    assert.match(await readFile(path.join(root,'failed/validation.json'),'utf8'),/rollback-restart/);
    replacement = '200';
    const success = await repairSource(provider,config,contract,plan,execution,2,path.join(root,'accepted'));
    assert.equal(success.policyDecision,'auto'); assert.equal(success.rollback,false);
    assert.equal(await readFile(path.join(root,'app/service.js'),'utf8'),'const status = 200;\n');
    assert.notEqual(success.beforeHashes['app/service.js'],success.afterHashes['app/service.js']);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('duplicate source text requires an explicit in-range occurrence and replaces only that match', async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'gauntlet-occurrence-'));
  try {
    await mkdir(path.join(root,'app'));await writeFile(path.join(root,'app/schema.py'),'class Input:\n    price: float\nclass Output:\n    price: float\n');
    const config={root,include:['app'],verifyCommand:['true'],restartCommand:['true'],maxAttempts:1,commandTimeoutMs:1000};
    const original=await sourceFiles(config);
    const edit={path:'app/schema.py',oldText:'    price: float',newText:'    price: float = Field(ge=0)'};
    await assert.rejects(applySourceEdits(config,original,[edit],path.join(root,'ambiguous')),/ANCHOR_NOT_UNIQUE/);
    await assert.rejects(applySourceEdits(config,original,[{...edit,occurrence:2}],path.join(root,'outside')),/OCCURRENCE_INVALID/);
    await applySourceEdits(config,original,[{...edit,occurrence:0}],path.join(root,'accepted'));
    assert.equal(await readFile(path.join(root,'app/schema.py'),'utf8'),'class Input:\n    price: float = Field(ge=0)\nclass Output:\n    price: float\n');
  } finally {await rm(root,{recursive:true,force:true});}
});
