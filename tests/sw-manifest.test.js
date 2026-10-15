import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The committed manifest must match the files, so the deployed site is the one in the repository and
// browsers can install it. Rebuild with: node scripts/build-sw-manifest.mjs
test('sw-manifest.json and the version in sw.js are current', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sw-manifest-'));
  try {
    cpSync('site', join(dir, 'site'), { recursive: true });
    assert.equal(spawnSync('node', ['scripts/build-sw-manifest.mjs', join(dir, 'site')], { stdio: 'ignore' }).status, 0);
    for (const f of ['sw-manifest.json', 'sw.js']) assert.equal(readFileSync(join(dir, 'site', f), 'utf8'), readFileSync(join('site', f), 'utf8'), `${f} is stale`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
