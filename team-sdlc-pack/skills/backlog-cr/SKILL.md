---
name: backlog-cr
description: Playbook for an MTM CR-xx change request - implement the new spec completely with tests, MVS must pass, evidence mandatory, often under a deadline.
---

# CR: implement the new spec completely

Target ~14 minutes; watch `!! WRAP UP`. Long spec -> spawn `team_repo_scout` (`fork_turns: "none"`, spec saved to `.mtm-notes/<ID>-spec.md` and passed as a path) for an acceptance breakdown while you locate touchpoints.

1. `start_work <ID>`. If the spec cites an internal standard, format, fixture set or ticket, search it with `match_mcp` first and follow it literally (column order, encoding, rounding, naming); cite the document id in the answer. Notes: one acceptance line per rule, number, name, default, format and "must never" statement in the spec; plus the boundaries of each rule and the old behaviour that must stay. A "never" rule applies to existing data too.
2. Touchpoints (search): data/config, business logic, validation, API/serialization, UI (buttons, labels, states), docs listing behaviour, permissions. Put them in scope.
3. Implement in small steps, following existing patterns (routing, naming, error format, i18n, where config lives). Backward compatible for everything the spec does not change. No new dependency unless the spec requires it.
4. Tests: each MVS scenario at its layer + each acceptance line + boundaries (exactly at a limit, just over, zero, rounding) + unchanged old behaviour. Update only tests that encode a rule this CR's spec explicitly changes, and name them in the answer.
5. Typical hidden checks to cover when relevant:
   - Export/download (CSV/Excel): header row and column order as specified; respects current filters/search/sort (not just the current page unless specified); escaping of commas, quotes, newlines; leading `=`, `+`, `-`, `@` neutralized against formula injection; UTF-8 (BOM if Excel is named); empty result -> header only; dates/numbers in the documented format; correct Content-Type and filename; permission checks same as the list.
   - New endpoint next to existing ones: same auth, validation and error shape; harmless normalization the route family already accepts (trailing slash, query params) keeps working.
   - Settings/limits: default value, min/max, invalid input message.
6. **Full suite + build/typecheck, both green.** Acceptance usually requires it outright; a pre-existing failure is not an excuse. A baseline test that contradicts this CR's spec may be corrected (explain it); a baseline failure unrelated to the spec is resolved by the source-of-truth order (team-orchestrator Trap awareness) - when the design records support the test, fix the code and keep the test. Report BACKLOG_TESTS.
7. Review with `team_quality_checker` (`fork_turns: "none"`, brief with checklist path, diff command and test commands); close GAPs.
8. Answer + evidence per MVS scenario (evidence-and-answer skill); list what changed per rule and assumptions.
9. Commit `<ID>: <change>`, push, `submit_work <ID>`.
On `!! WRAP UP`: stop polishing; ship the complete, tested core.
