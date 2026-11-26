import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('../../app/scripts/zerops/push-service.sh', import.meta.url));

test('the real uploader recognizes the stable shop setup and refuses an absent package before contacting Zerops', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'stable-shop-dispatch-'));
  try {
    const result = spawnSync('bash', [script, 'not-a-live-service', 'shop', 'not-a-release'], {
      cwd: directory,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, TMPDIR: directory, ZEROPS_TOKEN: 'test-only-not-a-credential' },
    });
    assert.notEqual(result.status, 0);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(output, /the shop push needs app\/zerops\.yaml/u);
    assert.doesNotMatch(output, /unknown zerops\.yaml setup/u);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
