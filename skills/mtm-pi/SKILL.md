---
name: mtm-pi
description: Playbook for a Master the Machine Product Incident (PI-xx), a production issue reported with little information and scored by finishing order. Use as soon as a PI item appears.
---

# PI: production incident (race)

The clock started when the PI was revealed. Finishing order sets the points (100/90/75/60%). FAILED scores 0, so verify once, properly, then ship.

1. `{{MTM}} start <ID>` (for an item you started before it only reprints the material). The published rules give PI no MVS; if the real Start response or submission template nevertheless contains an organizer requirement, follow that exact response. In the contract fill only outcome and the repro line now; the rest after the fix.
2. Locate fast (aim for 5 minutes). If you can spawn sub-agents, start the 2 read-only explorers from AGENTS.md now and keep going yourself:
   - Search the symptom words, error codes, endpoints and messages from the brief (`rg -n`, or `git grep -n`).
   - Read logs (`logs/`, `*.log`, see the repo map) and stack traces with file:line.
   - Incidents often come from the latest customer release: `git log --oneline -15`. Commits whose message contains a backlog id (TASK-, BUG-, CR-, PI-, also inside `fix(BUG-01): ...`) are your team's; the newest other commits are the customer's. Run `git show --stat <sha>` on them and read the suspicious diff.
   - Keep `.mtm/items/<ID>/notes.md` in three lists: `fact:` (with file:line or log line), `guess:`, `unknown:`. Never fix a guess.
3. Reproduce with a small failing test next to the existing tests. No repro means no trusted fix.
4. Fix the root cause with the smallest safe change. No refactoring. Unaffected paths keep their behaviour, including any rule the faulty change added on purpose.
5. Delete scratch files. `{{MTM}} review <ID>`: fix any OUT OF SCOPE or NO TEST line, answer its checks in 3 lines yourself. Then `git status --short`, `git add <files>`, `git commit -m "<ID>: <fix>"` (separate commands).
6. Verify the committed fix once: the repro test plus the affected module's tests (the full suite too when the baseline says it takes under 3 minutes): `{{MTM}} evidence <ID> [--cwd <module>] -- <command> [args...]`. MTM records this evidence but does not invent a mandatory PI evidence gate when the organizer's config does not require one.
7. `git push`, then `{{MTM}} fill <ID> 'summary=...' 'rootCause=... (the fact, with file:line)' 'impact=...' 'evidence=...'` (use the template's field names), then `{{MTM}} submit <ID>`.
8. If mtm names an interrupted item and its stash, pop it (`git stash pop 'stash@{N}'`) and continue that item.
