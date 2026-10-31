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

export function parsePs(stdout) {
  return String(stdout || '').split('\n').flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return m ? [{ ProcessId: Number(m[1]), ParentProcessId: Number(m[2]), CommandLine: m[3] }] : [];
  });
}

/** Kill only processes with this exact worktree path in their command line. */
export async function stopWorktreeProcesses(root) {
  if (!root || !path.isAbsolute(root)) throw new Error('An absolute worktree path is required');
  let rows;
  if (process.platform === 'win32') {
    // Bounded: a hung WMI query must not hold the helper lock (worktree remove) for the rest of the match.
    try {
      const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress'], { windowsHide: true, maxBuffer: 8_000_000, timeout: 20000 });
      rows = JSON.parse(stdout || '[]');
      if (!Array.isArray(rows)) rows = [rows];
    } catch { rows = []; }
  } else {
    // macOS has no /proc: `ps` works on macOS and Linux and also gives the parent pid we must not kill.
    try {
      const { stdout } = await exec('ps', ['-axww', '-o', 'pid=,ppid=,command='], { maxBuffer: 16_000_000, timeout: 20000 });
      rows = parsePs(stdout);
    } catch {
      rows = fs.existsSync('/proc') ? fs.readdirSync('/proc').filter(n => /^\d+$/.test(n)).flatMap(n => {
        try {
          const stat = fs.readFileSync(`/proc/${n}/stat`, 'utf8');
          return [{ ProcessId: Number(n), ParentProcessId: Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]), CommandLine: fs.readFileSync(`/proc/${n}/cmdline`, 'utf8').replace(/\0/g, ' ') }];
        } catch { return []; }
      }) : [];
    }
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
