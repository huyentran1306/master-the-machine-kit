import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVmStat, availableMemory, dispatchPolicy } from '../team-sdlc-pack/src/dispatch.mjs';
import { parsePs, stopWorktreeProcesses } from '../team-sdlc-pack/src/process-cleanup.mjs';

// Real `vm_stat` shape from an Apple-silicon Mac (16 KB pages): only ~0.4 GB "free" but ~6 GB reclaimable.
const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               25000.
Pages active:                            400000.
Pages inactive:                          350000.
Pages speculative:                        18000.
Pages throttled:                              0.
Pages wired down:                        150000.
Pages purgeable:                          20000.
`;

test('macOS available memory counts free + inactive + speculative pages, not only "Pages free"', () => {
  assert.equal(parseVmStat(VM_STAT), (25000 + 350000 + 18000) * 16384);
  const bytes = availableMemory({ platform: 'darwin', readVmStat: () => VM_STAT, now: 1e15 });
  assert.ok(bytes / 1024 ** 3 > 5.9);
  const code = { id: 'BUG-01', type: 'BUG', title: 'Fix it', local: {} };
  assert.equal(dispatchPolicy(code, [code], {}, 25000 * 16384).reason, 'LOW_RAM'); // what os.freemem() would say
  assert.equal(dispatchPolicy(code, [code], {}, bytes).allowed, true);
  assert.equal(parseVmStat('garbage'), 0);
});

test('process listing parses ps output (macOS has no /proc) and cleanup never touches unrelated paths', async () => {
  const rows = parsePs('  101     1 /usr/bin/node /Users/pro/ws/.mtm-wt/BUG-01/app/server.js\n  102   101 next dev -p 3100\n');
  assert.deepEqual(rows[0], { ProcessId: 101, ParentProcessId: 1, CommandLine: '/usr/bin/node /Users/pro/ws/.mtm-wt/BUG-01/app/server.js' });
  assert.equal(rows[1].ParentProcessId, 101);
  assert.deepEqual(await stopWorktreeProcesses('/nonexistent/mtm-wt/NOPE-1'), []);
});
