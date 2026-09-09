import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';

const execute = promisify(execFile);

test('training inventory example completes with a clean critic verdict', { timeout: 240_000 }, async () => {
  const { stdout } = await execute(process.execPath, ['training/example-project/run-demo.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, TRAINING_API_KEY: 'training-local-key' },
  });
  assert.match(stdout, /"example": "training-inventory-api"/);
  assert.match(stdout, /"status": "PASSED"/);
  assert.match(stdout, /"score": 100/);
  assert.match(stdout, /"hardFindings": \[\]/);
});
