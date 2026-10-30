import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

export function containsWorktree(command, root) {
  const normalize = s => String(s).replace(/\\/g, '/').toLowerCase();
  const text = normalize(command), target = normalize(path.resolve(root));
  let pos = text.indexOf(target);
  while (pos >= 0) {
    if ((pos === 0 || /[\s"'=]/.test(text[pos - 1])) && (pos + target.length === text.length || /[\s"'/]/.test(text[pos + target.length]))) return true;
    pos = text.indexOf(target, pos + 1);
  }
  return false;
}

/** Kill only processes with this exact worktree path in their command line. */
export async function stopWorktreeProcesses(root) {
  if (!root || !path.isAbsolute(root)) throw new Error('An absolute worktree path is required');
  let rows;
  if (process.platform === 'win32') {
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress'], { windowsHide: true, maxBuffer: 8_000_000 });
    rows = JSON.parse(stdout || '[]');
    if (!Array.isArray(rows)) rows = [rows];
  } else {
    rows = fs.readdirSync('/proc').filter(n => /^\d+$/.test(n)).flatMap(n => {
      try { return [{ ProcessId: Number(n), CommandLine: fs.readFileSync(`/proc/${n}/cmdline`, 'utf8').replace(/\0/g, ' ') }]; } catch { return []; }
    });
  }
  const excluded = new Set([process.pid, process.ppid]);
  let parent = process.ppid;
  while ((parent = rows.find(r => r.ProcessId === parent)?.ParentProcessId) && !excluded.has(parent)) excluded.add(parent);
  const stopped = [];
  for (const row of rows) {
    if (excluded.has(row.ProcessId) || !containsWorktree(row.CommandLine || '', root)) continue;
    try { process.kill(row.ProcessId); stopped.push(row.ProcessId); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  }
  return stopped;
}
