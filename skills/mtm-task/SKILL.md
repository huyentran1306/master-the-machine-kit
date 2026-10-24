---
name: mtm-task
description: Playbook for a Master the Machine TASK-xx general assignment without MVS; do exactly what is asked, verified, and submit once.
---

# TASK: general assignment

1. `{{MTM}} start <ID>` (for an item you started before it only reprints the material). Read the brief (including "Other fields") and the template: every template field hints at what Grader checks.
2. In the Task Contract (`.mtm/items/<ID>/contract.md`) list each concrete deliverable of the brief (code, endpoint, config, doc line, file) as an acceptance line. Do all of them, including docs.
3. Follow the repo's existing patterns (routing, naming, error format, where version and config are read). Do not hardcode values the repo already keeps elsewhere.
4. Add tests for the new behaviour, including simple variants (query strings, trailing slash, missing input) when they apply. Follow the existing router's normalization for sibling routes; do not assert that a harmless trailing slash is a 404 unless the brief says so. For a response sourced from module-owned data, mutate the returned object/array and call again: never expose mutable internal state. Verify the exact documentation file named in the brief, not a guessed alias. Build once. Delete scratch files.
5. `{{MTM}} review <ID>` and answer its checks in a few lines yourself; close every gap.
6. `git status --short`, then `git add <files>`, then `git commit -m "<ID>: <what>"` (separate commands).
7. `{{MTM}} evidence <ID> [--cwd <module>] -- <full test command>` on the commit.
8. `git push`, then `{{MTM}} fill <ID> 'summary=... Assumptions: ...' 'evidence=...'` (use the template's field names), then `{{MTM}} submit <ID>`. Back to the match loop.
