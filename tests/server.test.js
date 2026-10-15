import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

test('development server answers a malformed percent escape with 400 and keeps running', async () => {
  const port = 4300 + Math.floor(Math.random() * 500);
  const child = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' }, stdio: 'pipe' });
  try {
    await new Promise((resolve, reject) => { child.stdout.on('data', resolve); child.on('exit', reject); });
    const bad = await fetch(`http://127.0.0.1:${port}/%ZZ`);
    assert.equal(bad.status, 400);
    const ok = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(ok.status, 200);
    assert.equal(child.exitCode, null);
  } finally { child.kill(); }
});
