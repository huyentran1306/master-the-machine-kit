import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the rehearsal launcher selects the Windows Codex wrapper and terminates a Windows process tree', () => {
  const text = fs.readFileSync(path.join(KIT, 'mock', 'rehearsal-autoplay.mjs'), 'utf8');
  assert.match(text, /process\.platform === 'win32' \? 'codex\.cmd' : 'codex'/);
  assert.match(text, /spawnSync\('taskkill', \['\/PID', String\(child\.pid\), '\/T', '\/F'\]/);
  assert.match(text, /Waiting for READY/);
});

test('the PowerShell rehearsal entry point installs explicitly and uses npm.cmd', () => {
  const text = fs.readFileSync(path.join(KIT, 'run-rehearsal.ps1'), 'utf8');
  assert.match(text, /\[switch\]\$Install/);
  assert.match(text, /npm\.cmd --prefix \$KitRoot run rehearsal:autoplay/);
  assert.match(text, /MTM-KIT 0\.3\.2 is not installed/);
});
