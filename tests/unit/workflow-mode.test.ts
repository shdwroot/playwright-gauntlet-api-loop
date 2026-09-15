import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../src/config.js';

test('workflow defaults closed and explicit tests-only overrides persisted source repair', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gauntlet-modes-'));
  const names = ['GAUNTLET_WORKFLOW', 'GAUNTLET_API_SOURCE', 'GAUNTLET_AGENT_PROVIDER'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    const raw = JSON.parse(await readFile('gauntlet.offline.config.json', 'utf8'));
    raw.sourceRepair = { root, include: ['app'], verifyCommand: ['node', '--check', 'app.js'], restartCommand: ['node', 'restart.js'] };
    const file = path.join(root, 'gauntlet.config.json');
    await writeFile(file, JSON.stringify(raw));
    assert.equal((await loadConfig(file)).config.sourceRepair, undefined);
    raw.workflow = 'source-repair'; raw.agents.provider = 'openai';
    await writeFile(file, JSON.stringify(raw));
    assert.equal((await loadConfig(file)).config.sourceRepair?.root, root);
    process.env.GAUNTLET_WORKFLOW = 'tests-only';
    process.env.GAUNTLET_API_SOURCE = '/does-not-exist';
    const disabled = (await loadConfig(file)).config;
    assert.equal(disabled.workflow, 'tests-only');
    assert.equal(disabled.sourceRepair, undefined);
    process.env.GAUNTLET_WORKFLOW = 'source-repair';
    await assert.rejects(loadConfig(file), /SOURCE_ROOT_MISMATCH/);
    process.env.GAUNTLET_API_SOURCE = root;
    assert.equal((await loadConfig(file)).config.sourceRepair?.root, root);
    delete process.env.GAUNTLET_API_SOURCE;
    delete raw.sourceRepair;
    await writeFile(file, JSON.stringify(raw));
    await assert.rejects(loadConfig(file), /SOURCE_REPAIR_NOT_CONFIGURED/);
    process.env.GAUNTLET_WORKFLOW = 'anything';
    await assert.rejects(loadConfig(file), /workflow must be/);
  } finally {
    for (const name of names) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
    await rm(root, { recursive: true, force: true });
  }
});
