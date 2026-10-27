---
name: evidence-and-answer
description: How to fill answers/<ID>/submit.json from the Start Work template and write evidence files that an AI grader accepts, for any MTM backlog item.
---

# Answer + evidence contract

Paths (relative to `<matchRoot>` = `<checkoutRoot>/<folder>`):
- `answers/<ID>/submit.json` - created by start_work from `submitTemplate`. Edit it with apply_patch. Valid JSON, UTF-8, no BOM.
- `answers/<ID>/evidence/<file>` - every evidence file. In JSON reference it as `"evidence/<file>"` (never `answers/<ID>/...`, never `./evidence`).
- Never create `<folder>/evidence/` or `<folder>/challenge/evidence/`. `challenge/<ID>-submit.json` is a read-only source template.

## Filling the template
- Keep every key and the structure of `submitTemplate`; fill every field. Do not add keys the template does not have unless an instruction asks for them.
- **Use what Start Work shipped.** `start_work` returns `providedFiles` and `providedRunners` (absolute paths). A check runner the organizer sends loads the OFFICIAL QA data and the item is graded on its output: run it exactly as shipped and keep what it writes. Your own script, or your own data, produces numbers that cannot match the expected results - it looks green to you and scores zero. Only write your own check when nothing was shipped.
- **Evidence file names are part of the spec.** When the MVS or the brief names an evidence file (`install.log`, `audit.log`, `typecheck.log`, `test.log`, `<ID>-TC-01.json`), produce that exact name - no alias, no extra suffix. A grader looks for the name it asked for.
- `backlogId` = the item ID. `status`: the value the template/startInstruction defines for a finished item (e.g. SUBMITTED / DONE / COMPLETED). **PARTIAL and NOT_RUN are read as 'not done' and score accordingly** - before you write either, go back and run the provided runner, or the narrowest real check that exists. Use PARTIAL only when a requirement is genuinely impossible, and say why in one line. Never leave DRAFT / NOT_STARTED.
- `gitRevision` inside the answer (if the template has it): leave as is; the helper sets it to the submitted SHA. The SHA always also goes at the request root (helper).
- One `testResults` entry per MVS scenario, using the scenario IDs from MVS (e.g. `BUG-01-TC-01`): `result` PASSED/FAILED/NOT_RUN as really observed, a one-line `note`, and `evidence` refs. Add your extra (hidden-scenario) tests as extra entries only if the template's shape allows; otherwise mention them in the analysis/summary.
- Summary/analysis fields: root cause (file:line) or what changed per rule, why it is correct, what else was checked (regression, edge cases), assumptions. Plain and specific. 3-8 sentences.
- `changes`/files fields: the real files you changed and one line each.
- Collaboration field (e.g. `aiCollaboration`): who did what (orchestrator, team_repo_scout, team_feature_worker, team_quality_checker), truthfully.

## Evidence files (markdown, one per scenario)
Name: `<ID>-TC-01.md`, `<ID>-TC-02.md`, ... plus `<ID>-regression.md` for the full-suite/build run.
```
# BUG-01-TC-01 - <scenario title>
- Scenario: <from MVS>
- Revision: <short SHA or "working tree before commit">
- Command: <exact command>
- Expected: <...>
- Actual: <observed output, the relevant lines only>
- Result: PASSED
```
- Paste only the relevant output lines (test names + summary counts), never whole logs.
- UI items: a screenshot is strong evidence, taken with a headless browser started as a command (never Computer Use, which needs an operator approval). In order of preference:
  1. `pnpm exec playwright screenshot --viewport-size=1440,900 "http://localhost:<port>/<page>" "<matchRoot>/answers/<ID>/evidence/<ID>-after-1440.png"` when the repo has Playwright.
  2. A headless Chrome/Edge binary, whichever this machine actually has - macOS: `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"`; Windows: `& "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"`; Linux: `google-chrome` or `chromium` - with `--headless=new --disable-gpu --window-size=1440,900 --screenshot="<absolute path>" "<url>"`.
  Not runnable within 3 minutes -> skip screenshots, rely on component/unit tests + build, and say so in the answer.
- PI: a repro test failing before and passing after is the evidence (`<ID>-repro.md`), plus the affected module's tests.

## When the answer rests on internal material
If a rule came from the match MCP server (internal standard, fixture set, ticket), name the document id in the analysis/summary field and, when it decided a concrete choice, quote the one line it decided (column order, encoding, rounding). That is what tells the grader the choice was not invented. If nothing was available, write the assumption you used instead - never leave the field vague.

## Before commit
- `submit.json` parses (`node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" "<path>"`).
- Every `evidence/<file>` you referenced exists. Remove `.gitkeep` only if real evidence exists (harmless either way).
- Stage answers with the code: `git -C "<checkoutRoot>" add "<folder>/answers/<ID>"`.
- `submit_work <ID> dryRun:true` lists anything missing in the commit.
