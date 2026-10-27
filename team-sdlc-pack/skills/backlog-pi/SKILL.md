---
name: backlog-pi
description: Playbook for an MTM Product Incident (PI-xx) - production issue with little information, highest priority, scored by finishing order; investigate fast, fix the root cause minimally, verify once, ship.
---

# PI: production incident (race)

The clock started at reveal; rank is by the server's receivedAt of a PASSED submission (100/90/75/60%). FAILED = 0, so verify once, properly, then ship. No MVS: Grader has its own criteria. Target <= 10 minutes.

1. `start_work <ID>` immediately (stash/commit current work first). Read description + startInstruction + template. Notes: outcome + repro line only.
2. Locate (aim 4 minutes). In parallel, spawn `team_repo_scout` with the symptom text and matchRoot ("find root cause, 15 lines, file:line") and keep searching yourself:
   - `rg -n` the symptom words, error codes, endpoints, UI labels, messages.
   - Logs: `logs/`, `*.log`, recon `logs` list; read stack traces to file:line.
   - Recent customer changes cause most incidents: `git -C "<checkoutRoot>" log --oneline -15 -- "<folder>"`, then `git show --stat <sha>` and the suspicious diff. Commits named with backlog IDs are teams' work; others are the customer's.
   - Keep `fact:` (file:line / log line), `guess:`, `unknown:` in notes. Never fix a guess.
3. Reproduce with the smallest failing test next to existing tests (or a scripted request). No repro = no trusted fix.
4. Fix the root cause with the smallest safe change, where it lives (all paths through that code). Keep any rule the faulty change added on purpose. No refactoring.
5. Run the repro + the affected module's tests; run the full suite too unless baseline says it is slow and the clock forbids it (PI is a race, but a red suite still fails acceptance). Build/typecheck once. Report BACKLOG_TESTS.
6. Answer: incident summary, root cause with file:line + the commit that introduced it, impact, fix, verification, prevention note. Evidence: `<ID>-repro.md` (before -> after) + `<ID>-regression.md`.
7. Commit (`<ID>: fix <symptom>`), push, `submit_work <ID>`. Then pop the stashed WIP (`git stash list`; `git stash pop 'stash@{N}'`).
- `!! PI SPRINT` = stop expanding scope and ship the verified fix now.
