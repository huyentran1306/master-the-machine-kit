# Windows readiness — MTM-KIT 0.3.2

The MTM runtime is Node.js and is designed to run on Windows PowerShell 5.1. The rehearsal launcher now uses `codex.cmd` and `taskkill /T /F` on Windows, while the core command runner already handles `npm.cmd`, `cmd.exe` quoting, Windows paths and process-tree timeouts.

## One-time setup

1. Install current Node.js, Git and Codex CLI; open a new PowerShell and verify `node --version`, `git --version`, `codex --version`.
2. Extract this exact `Master_the_Machine_DPT_0.3.2` folder to a short path with write access, for example `C:\MTM\Master_the_Machine_DPT_0.3.2`.
3. In PowerShell, enter `dpt-kit` and run:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\run-rehearsal.ps1 -Install
```

`-Scope Process` changes only the current PowerShell window. The install creates the versioned runtime and merges the three MTM hooks into the current user's Codex configuration. Review/trust those hooks in interactive Codex once if you will use interactive mode; the local rehearsal launcher supplies its own controlled hook-trust bypass.

## Rehearsal commands

```powershell
# 40 real minutes — comparable score
.\run-rehearsal.ps1

# About 10 minutes — smoke test only, not a score forecast
.\run-rehearsal.ps1 -TimeScale 4
```

The script creates a fresh workspace and new local port each time. Do not start a second run in the same terminal.

## Match-day checklist

- `git config --global core.longpaths true`
- Use a short workspace path, ideally under `C:\MTM`; avoid sync folders such as OneDrive/Desktop/Documents.
- Ensure the assigned repository can be cloned, committed and pushed before the official Start phase.
- Disable sleep and use stable power/network. Do not manually open a second Codex agent during a running match: manual-machine access costs official points under the announced rules.
- Keep the full path to the BTC-supplied mtm-player/team pack available. This rehearsal launcher is local-mock only; it must never launch an official match.

## What still needs BTC confirmation

The Windows support does not invent the official player integration. The example team-pack schema, `progress.ndjson` transport, login/read/submit operations, receipt schema and token scopes are still required before `official-team-pack/` can be activated.
