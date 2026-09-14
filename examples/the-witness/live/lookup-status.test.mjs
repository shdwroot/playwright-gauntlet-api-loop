import assert from 'node:assert/strict';
import test from 'node:test';

import { isUsableLookupStatus } from './lookup-status.mjs';

test('complete and partial reports can continue through the full journey', () => {
  assert.equal(isUsableLookupStatus('complete'), true);
  assert.equal(isUsableLookupStatus('partial'), true);
});

test('failed, blocked, and in-progress lookups stop the full journey', () => {
  for (const status of ['failed', 'blocked', 'queued', 'observing', 'analysing', 'redacting']) {
    assert.equal(isUsableLookupStatus(status), false);
  }
});
