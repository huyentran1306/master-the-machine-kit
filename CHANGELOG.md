# Changelog

## 0.3.2 — 2026-10-23

- Add `official-team-pack/`: an mtm-player integration scaffold with Team Orchestrator and four specialist role declarations, append-only `progress.ndjson` event writer, and configuration template.
- Record the confirmed briefing sequence: `MATCH_LOGIN` → `ENVIRONMENT_READY` → `PREPARED` → official `IN_PROGRESS` → `BACKLOG_SYNC` / `DISCOVERED` before Start Work.
- Capture the known Start Work operation (`POST /api/v1/matches/{matchId}/backlogs/start`, body `backlogItemKey`) without marking any unknown login/read/submit/registration schema as verified.
- Add explicit scoring guidance: one submission per item, Start Work first, hard deadlines, grader result is authoritative, and each manual-machine access costs 50 official points; time and Codex-credit usage are separate tie-break metrics.
- Add Windows rehearsal support: `run-rehearsal.ps1`, `codex.cmd` handling, and `taskkill /T /F` process-tree cleanup; document the Windows machine-day checklist in `WINDOWS.md`.
- Keep the rehearsal adapter and mock launcher unchanged. They are not the official mtm-player integration.

Known external blocker: BTC's example team pack / complete mtm-player API or CLI contract is required before the template can be activated.

## 0.3.1 — 2026-10-21

- Pin hidden tests and the mock grader to TAP so Node 24 cannot turn passing tests into `grader ran no tests`.
- Require evidence by default for CR and BUG only; PI verification remains recommended but is not an undocumented submission gate.
- Remove the `--allow-dirty` and `--no-evidence` competition bypasses.
- Correct Codex instruction precedence and add `codex/LAUNCH_PROMPT.md` for the Game Player.
- Install a stable, versioned runtime under `CODEX_HOME`; moving the extracted kit no longer breaks commands or hooks.
- Add ownership markers, collision backups and ownership-aware uninstall for skills and runtime files.
- Add a live hook probe and doctor checks for global overrides, project instructions and disabled hooks.
- Mark the bundled Game Master adapter `REHEARSAL_ONLY`; real servers are refused until the adapter is explicitly verified.
- Protect a stored token with mode `0600` on POSIX and test that the token is never printed.
- Add Linux/Windows CI coverage for Node 18, 20, 22 and 24.
- Add `training-02`, a second 40-minute, 1,000-point rehearsal with ten independently graded items across nine release windows.

Known external blocker: the organizer's real Game Master/Game Player API or CLI contract is still required before setting `adapterStatus` to `VERIFIED`.
