import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('Cognito domain modes keep one style per app client and the cutover reuses installed parameters', () => {
  const result = spawnSync('python3', ['tests/cognito-cutover.py'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
