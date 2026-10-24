---
name: mtm-bug
description: Playbook for a Master the Machine BUG-xx item, fixing a defect to the expected behaviour without breaking anything else and submitting with MVS evidence.
---

# BUG: fix to expectation, break nothing

1. `{{MTM}} start <ID>` (for an item you started before it only reprints the material). Read the brief (including "Other fields") and the MVS it prints. MVS is the minimum: Grader checks more.
2. Fill the Task Contract (`.mtm/items/<ID>/contract.md`): the expected behaviour as outcome, every MVS plus at least two hidden scenarios (the same defect through another input, boundary or caller; the behaviour next to the fix that must not change), the files you expect to touch, assumptions.
3. Write the acceptance lines as tests first, at the layer each MVS names, plus the edge cases the brief implies (exact boundaries, just before and after, empty/null, case and whitespace). Run them and watch them fail for the right reason.
4. Find the root cause (search the function, read its callers). Fix it where it lives, so every path through that code is correct, not only the reported example. Check every caller of what you changed. If an existing test encodes the wrong behaviour, update it and say so in the submission.
5. Build once (the repo map's build command). Delete scratch files.
6. `{{MTM}} review <ID>` and do what it prints (reviewer sub-agent or a short self-review). Close every GAP with a test, then the code.
7. `git status --short`, then `git add <files>`, then `git commit -m "<ID>: <fix>"` (separate commands).
8. Evidence on the commit: `{{MTM}} evidence <ID> [--cwd <module>] -- <full test command>`; no new failures compared with `.mtm/baseline.md`.
9. `git push`, then `{{MTM}} fill <ID> 'rootCause=...' 'summary=... Assumptions: ...' 'evidence=each MVS with its result, extra cases, command and counts'` (use the template's field names), then `{{MTM}} submit <ID>`.
10. Back to the match loop (`{{MTM}} status`).
