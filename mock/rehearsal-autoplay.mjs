#!/usr/bin/env node
// One-command, rehearsal-only controller. It is deliberately separate from the
// Game Player: only this local mock controller starts the clock after READY.
// The agent still never sees or calls an /admin endpoint.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SCENARIO = path.join(HERE, 'scenarios', 'training-02', 'scenario.json');
const PROMPT = path.join(HERE, 'scenarios', 'training-02', 'START_PROMPT.md');
const SETUP = path.join(HERE, 'setup-rehearsal.mjs');
const KIT_VERSION = '0.3.2';
const RESUME_PROMPT = `The local MTM rehearsal is already RUNNING. You are resuming after a bounded non-interactive Codex turn ended.

Follow the MTM-KIT "Resume after a restart" procedure from the installed AGENTS.md, then execute the match loop until MTM prints MATCH FINISHED. The ledger is the source of truth. Do not call Admin or Grader APIs. Do not merely report status, recap, or exit while the match is RUNNING.`;

function usage() {
  console.log(`Usage: node mock/rehearsal-autoplay.mjs [--time-scale N] [--ready-timeout-min N] [--max-agent-turns N]

Creates a fresh rehearsal workspace, runs Codex non-interactively, waits for MTM READY,
then starts the local mock clock. This is only for the bundled mock - never use it
against an organizer Game Master.`);
}

function positive(name, value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number`);
  return n;
}

function options(argv) {
  // A score is meaningful only at the real match cadence. Faster scales are
  // useful for smoke tests, but amplify model/tool latency into lost game time.
  const out = { timeScale: 1, readyTimeoutMin: 10, maxAgentTurns: 24 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return { help: true };
    if (a === '--time-scale') out.timeScale = positive(a, argv[++i]);
    else if (a === '--ready-timeout-min') out.readyTimeoutMin = positive(a, argv[++i]);
    else if (a === '--max-agent-turns') out.maxAgentTurns = Math.floor(positive(a, argv[++i]));
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close((err) => err ? reject(err) : resolve(port));
    });
  });
}

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function isWindowsCommand(command) {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
}

function spawnCodex(command, args, options = {}) {
  return spawn(command, args, {
    ...options,
    // Windows npm installations commonly expose Codex as codex.cmd; cmd.exe is
    // required to launch that wrapper while direct binaries stay direct elsewhere.
    shell: isWindowsCommand(command),
    windowsHide: true,
  });
}

function terminate(child) {
  if (!child || child.exitCode != null) return;
  if (process.platform === 'win32' && child.pid) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    try { child.kill('SIGTERM'); } catch { /* already exited */ }
  }
}

async function waitForReady(matchFile, player, timeoutMs) {
  const startedAt = Date.now();
  let lastHeartbeat = 0;
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (player.failure) throw new Error(`Game Player could not start: ${player.failure.message}`);
    const { agent } = player;
    if (agent.exitCode != null) throw new Error(`Game Player exited before READY (code ${agent.exitCode})`);
    try {
      const match = JSON.parse(fs.readFileSync(matchFile, 'utf8'));
      if (match.armedAt) return;
      if (Date.now() - lastHeartbeat >= 15_000) {
        const elapsed = ((Date.now() - startedAt) / 60_000).toFixed(1);
        console.log(`Waiting for READY (${elapsed}m): MTM ledger exists; agent is still in preflight.`);
        lastHeartbeat = Date.now();
      }
    } catch { /* MTM has not created the ledger yet. */ }
    if (Date.now() - lastHeartbeat >= 15_000) {
      const elapsed = ((Date.now() - startedAt) / 60_000).toFixed(1);
      console.log(`Waiting for READY (${elapsed}m): agent has not created the MTM ledger yet.`);
      lastHeartbeat = Date.now();
    }
    await wait(500);
  }
  throw new Error('Game Player did not report READY before the rehearsal timeout');
}

async function waitForServer(baseUrl, server) {
  const until = Date.now() + 15_000;
  while (Date.now() < until) {
    if (server.exitCode != null) throw new Error(`mock server exited before accepting connections (code ${server.exitCode})`);
    try {
      const r = await fetch(`${baseUrl}/admin/state`);
      if (r.ok) return;
    } catch { /* Process still binding the local port. */ }
    await wait(100);
  }
  throw new Error('mock server did not start within 15 seconds');
}

async function postStart(baseUrl) {
  const r = await fetch(`${baseUrl}/admin/start`, { method: 'POST' });
  if (!r.ok) throw new Error(`mock start refused: HTTP ${r.status} ${await r.text()}`);
  const body = await r.json();
  if (body.status !== 'RUNNING') throw new Error(`mock start returned ${body.status || 'an unknown state'}`);
}

async function mockState(baseUrl, server) {
  if (server.exitCode != null) throw new Error(`mock server stopped unexpectedly (code ${server.exitCode})`);
  const r = await fetch(`${baseUrl}/admin/state`);
  if (!r.ok) throw new Error(`cannot read mock state: HTTP ${r.status}`);
  return r.json();
}

function startGamePlayer({ codex, workspace, prompt, runDir, turn }) {
  const finalPath = path.join(runDir, `codex-turn-${String(turn).padStart(2, '0')}.final.md`);
  const agent = spawnCodex(codex, ['exec', '--approve-for-me', '--dangerously-bypass-hook-trust', '--output-last-message', finalPath, '--cd', workspace, prompt], {
    // Keep the terminal visible. It is the known-good stdio mode for this CLI,
    // while --output-last-message leaves a durable artifact per bounded turn.
    cwd: workspace, stdio: ['ignore', 'inherit', 'inherit'],
  });
  const player = { agent, finalPath, failure: null, completion: null };
  player.completion = new Promise((resolve) => {
    agent.once('error', (e) => {
      player.failure = e;
      resolve({ error: e });
    });
    agent.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return player;
}

async function finishTurn(player) {
  const result = await player.completion;
  if (result.error) throw new Error(`Game Player could not start: ${result.error.message}`);
  return result;
}

async function main() {
  const o = options(process.argv.slice(2));
  if (o.help) return usage();
  const codex = process.env.CODEX_BIN || (process.platform === 'win32' ? 'codex.cmd' : 'codex');
  const visible = spawnSync(codex, ['--version'], { stdio: 'ignore', shell: isWindowsCommand(codex), windowsHide: true });
  if (visible.status !== 0) throw new Error(`Codex CLI was not found. Put it on PATH or set CODEX_BIN before running this launcher.`);

  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = path.join(ROOT, 'rehearsal-runs', `training-02-${runId}`);
  const setup = spawnSync(process.execPath, [SETUP, runDir], { cwd: ROOT, encoding: 'utf8' });
  if (setup.status !== 0) throw new Error(`could not create rehearsal workspace:\n${setup.stderr || setup.stdout}`);
  const workspace = path.join(runDir, 'workspace');
  const remote = path.join(runDir, 'remote.git');
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const prompt = fs.readFileSync(PROMPT, 'utf8').replaceAll('http://127.0.0.1:4020', baseUrl);

  console.log(`MTM rehearsal controller ${KIT_VERSION}`);
  console.log(`workspace: ${workspace}`);
  console.log(`Game Player: starting non-interactively; mock clock starts only after READY.`);

  const server = spawn(process.execPath, [path.join(HERE, 'gm-mock-server.mjs'), '--scenario', SCENARIO, '--remote', remote, '--port', String(port), '--time-scale', String(o.timeScale)], {
    cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'],
  });
  let agent = null;
  const stop = () => {
    terminate(agent);
    terminate(server);
  };
  process.once('SIGINT', () => { stop(); process.exitCode = 130; });
  process.once('SIGTERM', stop);

  try {
    await waitForServer(baseUrl, server);
    let turn = 1;
    let player = startGamePlayer({ codex, workspace, prompt, runDir, turn });
    agent = player.agent;
    console.log(`Codex turn ${turn} started; final message: ${player.finalPath}`);
    console.log(`Waiting up to ${o.readyTimeoutMin}m for MTM READY; a progress heartbeat prints every 15 seconds.`);
    await waitForReady(path.join(workspace, '.mtm', 'match.json'), player, o.readyTimeoutMin * 60_000);
    await postStart(baseUrl);
    console.log(`READY observed. Mock match is RUNNING (${o.timeScale}x); you may leave the machine.`);

    while (true) {
      const result = await finishTurn(player);
      const state = await mockState(baseUrl, server);
      console.log(`Codex turn ${turn} finished (${result.signal || `exit ${result.code}`}); mock is ${state.status} at ${state.clockMin}m.`);
      if (state.status === 'FINISHED') break;
      if (state.status !== 'RUNNING') throw new Error(`mock entered unexpected state ${state.status}`);
      if (turn >= o.maxAgentTurns) {
        throw new Error(`Codex left ${turn} times while the match was still RUNNING. Logs: ${runDir}/codex-turn-*.log`);
      }
      turn += 1;
      console.log(`Resuming Codex turn ${turn}.`);
      player = startGamePlayer({ codex, workspace, prompt: RESUME_PROMPT, runDir, turn });
      agent = player.agent;
      console.log(`Codex turn ${turn} started; final message: ${player.finalPath}`);
    }

    console.log('MATCH FINISHED. Generating coach dashboard.');
    const runtime = path.join(os.homedir(), '.codex', 'mtm-kit', KIT_VERSION, 'tool', 'mtm.mjs');
    const coach = spawnSync(process.execPath, [runtime, 'coach'], { cwd: workspace, encoding: 'utf8' });
    if (coach.status === 0) process.stdout.write(coach.stdout);
    else process.stderr.write(`coach unavailable: ${coach.stderr || coach.stdout}`);
    console.log(`dashboard: ${path.join(workspace, '.mtm', 'coach.html')}`);
  } finally {
    // A failure before the player exits must not leave Codex running in the
    // background (for example if the local mock cannot be started).
    terminate(agent);
    terminate(server);
  }
}

main().catch((e) => {
  console.error(`rehearsal autoplay: ${e.message}`);
  process.exitCode = 1;
});
