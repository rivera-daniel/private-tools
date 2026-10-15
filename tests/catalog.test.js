import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// The catalog and roadmap pages are generated from the registry. Regenerating must change nothing.
test('generated catalog and roadmap pages match the registry', () => {
  const before = ['site/index.html', 'site/roadmap/index.html'].map((f) => readFileSync(f, 'utf8'));
  const run = spawnSync('node', ['scripts/render-catalog.mjs'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const after = ['site/index.html', 'site/roadmap/index.html'].map((f) => readFileSync(f, 'utf8'));
  assert.deepEqual(after, before, 'run node scripts/render-catalog.mjs and commit the result');
});
