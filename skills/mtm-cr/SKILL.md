---
name: mtm-cr
description: Playbook for a Master the Machine CR-xx change request, changing the product to a new spec with full quality and MVS evidence, often under a deadline.
---

# CR: implement the new spec completely

1. `{{MTM}} start <ID>` (for an item you started before it only reprints the material). Read the brief (including "Other fields") and the MVS it prints. `!! WRAP UP` alerts tell you when the deadline or the match end is close.
2. Turn the spec into the Task Contract (`.mtm/items/<ID>/contract.md`): one acceptance line per rule, number, name, default and "must never" statement, plus the boundaries of each new rule and the old behaviour that must stay. A statement like "no X may ever..." applies to existing data too, not only to the new feature. Every line needs code and a test.
3. Find every touchpoint (search): data and config, business logic, validation, API and serialization, UI if any, docs that list behaviour. Put them in scope.allowed; anything you must not change goes in scope.excluded.
4. Implement in small steps. Keep backward compatibility for everything the spec does not change. Update existing tests that encode the old rule, and name them in the submission.
5. Tests: each MVS scenario at the layer it names, each acceptance line, boundaries (exactly at a limit, just over, zero, rounding), and the old behaviour that must not change. For a sibling endpoint, test the same harmless URL normalization already supported by its route family (especially one trailing slash plus query parameters); do not narrow it to a 404 unless the spec explicitly requires that.
6. Build once (the repo map's build command). Delete scratch files.
7. `{{MTM}} review <ID>` and do what it prints (reviewer sub-agent or a short self-review). Close every GAP with a test, then the code.
8. `git status --short`, then `git add <files>`, then `git commit -m "<ID>: <change>"` (separate commands).
9. Evidence on the commit: `{{MTM}} evidence <ID> [--cwd <module>] -- <full test command>`; no new failures compared with `.mtm/baseline.md`.
10. `git push`, then `{{MTM}} fill <ID> 'summary=what changed per rule. Assumptions: ...' 'evidence=MVS results, extra cases, command and counts'` (use the template's field names), then `{{MTM}} submit <ID>`.
11. On `!! WRAP UP`: stop polishing; ship the complete, tested core (steps 6 to 10, review as a self-check only).
