---
name: backlog-bug
description: Playbook for an MTM BUG-xx - fix a defect to the expected behaviour without breaking anything else; MVS must pass and evidence is mandatory.
---

# BUG: fix to expectation, break nothing

MVS is the minimum; Grader runs more. Target ~10 minutes.

1. `start_work <ID>`: description, MVS, template. Notes: expected behaviour (outcome); acceptance = every MVS scenario + 2-4 hidden ones: the same defect via another input/caller/page, exact boundaries, empty/null, case/whitespace, the neighbouring behaviour that must NOT change (e.g. mobile layout when fixing desktop, other statuses when fixing one).
2. Tests first at the layer each MVS names (HTTP: status + fields; service/query: data; UI: component/DOM/CSS class). Watch them fail for the right reason.
2b. If the expected behaviour is defined by an internal standard or ticket the brief names, search it with `match_mcp` and make the fix match it.
3. Root cause: search the function/query/style, read its callers. Fix where it lives so every path is correct, not only the reported example. Data bugs: fix the query/filter for every report/list that shows the data (e.g. voided/deleted/cancelled records excluded everywhere they must be), and consider existing data.
4. Change an existing test only when this item's text or an authoritative source shows the test encodes the wrong behaviour; name it and cite the source in the answer. Never delete/skip/weaken tests (see team-orchestrator Trap awareness).
5. Targeted tests -> **the full suite** -> build/typecheck. Both must be green at submit time: acceptance usually says `test` and `typecheck` pass. A failure already in `.mtm-notes/baseline.md` still counts against you: decide with the source-of-truth order (team-orchestrator Trap awareness) whether the code or the test is wrong; when the design records support the test, fix the code and keep the test. Report BACKLOG_TESTS.
6. Review: spawn `team_quality_checker` with `fork_turns: "none"` and a brief (checklist path, MVS names, `git diff` command, test commands; see team-orchestrator Subagents). Close every GAP with a test first.
7. Answer + evidence (evidence-and-answer skill): one evidence file per MVS scenario + regression file. Root cause with file:line in the analysis.
8. Commit `<ID>: fix <what>` (code + tests + answers together), push, `submit_work <ID>`.
