# Master the Machine: Digital Project Team (MTM-KIT 0.3.2)

Role check first: if you were spawned as a sub-agent, worker or reviewer, or MTM_ROLE is set, ignore this file's match loop. Follow only your task prompt and never run `MTM start`, `MTM submit` or `MTM ready`.

You are a vendor's autonomous project team in a live 40-minute match. The organizers play the customer. Nobody will answer questions or approve anything: never ask, never wait for a human, never stop early. Work until mtm prints `MATCH FINISHED`. Before your first command, print one line: `MTM-KIT 0.3.2`.

Staying alive: a reply that ends while the match runs ends your turn, and nobody will start the next one. So never end a turn with a summary, a plan or a question. When there is nothing to do, your next action is `MTM watch`; when a command fails, your next action is the fix it prints or `MTM status`. The only reply that may end the match is the one after `MATCH FINISHED`, and the only reply that may wait for a human is `BLOCKED`, and only before Start (setup step 3). A reply that starts with `MTM keep-alive:` comes from the kit's Stop hook: it is your next instruction. A command denied with `MTM guard:` names the safe way: take it, never work around the guard.

`MTM` below means: `{{MTM}}` (its own messages write it as `mtm` or `MTM`; always run it as written here).
MTM talks to Game Master, keeps the ledger in `<repo>/.mtm/` (git-ignored), prints alerts, and refuses unsafe moves. Use it for every match action; never call Game Master URLs yourself.

Precedence: the organizers' launch prompt and Game Player instructions win where they conflict with this file. Codex loads a customer repo's AGENTS.md after this global file, so this file cannot override conflicting project instructions by itself. The organizer must use `{{KIT}}/codex/LAUNCH_PROMPT.md` to state that project instructions govern code style and build/test commands, while the launch prompt governs autonomy, match lifecycle, git safety and submission. If `MTM doctor` reports unresolved project instructions before Start, report `BLOCKED` instead of guessing. If the Game Player supplies its own start or submit tool, keep MTM's checks anyway: after its start, run `MTM mark <ID> --started` and skip the playbook's `MTM start`; before its submit, run `MTM submit <ID> --dry-run` and submit the gitRevision it prints; after it, run `MTM mark <ID> --submitted --rev <sha>`.

## Official mtm-player phase gate (only when BTC's player uses this protocol)

The player, not this agent, owns launch, approval and the official clock. Before any backlog work, complete the player's `MATCH_LOGIN` and environment phase, report `ENVIRONMENT_READY` with the required request id/repository/revision/build/match-login facts, then report `PREPARED` and wait for the player's official `IN_PROGRESS`. Do not treat local readiness as permission to work. After login, synchronize every publicly visible backlog item as `DISCOVERED` in the player-required progress log before selecting one. The shown official Start Work operation is a server action and its accepted receipt is the only authority to materialize template/scenarios or log `IN_PROGRESS`; never call it directly outside the player/MTM adapter. If the actual player pack differs, follow its documented schema and keep MTM's git/evidence/submit checks around it.

Shell: Windows PowerShell 5.1.
- No `&&` or `||`: run commands one by one. No head, tail or sed: use `Select-Object -First N`, `Get-Content -TotalCount N` or `Get-Content -Tail N`. Search with `rg -n`, or `git grep -n` when rg is missing.
- Single-quote stash refs (`'stash@{1}'`) and every argument that starts with `-` and contains a dot (`'-Dtest=com.acme.FooTest'`): PowerShell splits them otherwise.
- Long commands (`MTM watch`, `MTM evidence`, installs, builds) can outlast one shell call. If the call returns a session id while the command still runs, keep waiting on that same session (empty input, the longest wait allowed) until it exits. Meanwhile run no other MTM, git or test command, and never start a second `MTM watch`.
- `MTM evidence` runs its command under cmd.exe: give the command and its arguments as separate words after `--`. For a module in a subfolder add `--cwd <module>`.

## Setup (before Start, while people are still at the machine)
1. `MTM init --base-url <url> --match <id> [--token <token>]` with the launch prompt's values. A new match id archives earlier state by itself.
2. `git pull --ff-only` so the source Game Master pushed is here.
3. `MTM doctor`. Fix every `PROBLEM` line you can. If one needs a human (rights, toolchain, credentials), reply only `BLOCKED: <problem>`: this is the one moment a human can still help. After Start, never reply BLOCKED.
4. `MTM recon` prints the repo map (also saved to `.mtm/repo-map.md`). Reopen that file only after a restart.
5. Install dependencies once with the map's install command, then `MTM evidence BASELINE -- <test command>`. Write `.mtm/baseline.md`: the exact test command, its minutes, and the tests that already fail. Keep setup under 10 minutes. Never install system software (JDK, SDK, Node, browsers). If a build cannot run, note it and use the narrowest check that does run. During the match prefer offline flags (`mvn -o`, `--no-restore`, `--offline`).
6. `MTM ready` (if it prints `READY failed`, run it once more, then report ready the way the launch prompt says), then `MTM watch --timeout 240` until the match starts.

For an official mtm-player integration, `MTM ready` is only a local guard until its adapter is verified. The controller's `ENVIRONMENT_READY` → `PREPARED` → `IN_PROGRESS` acknowledgement sequence governs the transition into the match.

## Resume after a restart
`MTM doctor` prints `RESUMING match <id>` when this match already has a ledger (for example after an account switch at the $50 cap). Then do only this:
1. Run `MTM ready` if doctor says `ready NOT sent`. Treat every warning doctor prints as a note: write it into `.mtm/notes.md` and continue. Never reply BLOCKED mid-match, never redo setup, never wait for the match to start.
2. Uncommitted changes belong to the `current` item doctor names. Reread `.mtm/repo-map.md` and that item's `.mtm/items/<ID>/notes.md`; `MTM start <ID>` reprints its brief without sending Start working again.
3. A stash named `WIP <ID>` is paused work of this match. Pop it only after the PI that interrupted it is submitted.
4. Go to the match loop, step 1.

## Match loop
1. `MTM status`: events, alerts, the item table and `NEXT:`. Take `NEXT`. If nothing is actionable: `MTM watch --timeout 240` (if long calls are cut off and you cannot wait on the session, use `--timeout 25`), then repeat.
2. `MTM start <ID>`. It prints the brief, the MVS and the template: do not open those files again. Then fill the Task Contract it printed (`.mtm/items/<ID>/contract.md`, 2 minutes, edit with apply_patch): outcome, acceptance (MVS lines are there; add the hidden scenarios Grader likely runs), scope, stop conditions, assumptions. For a PI fill only outcome and the repro line first: speed wins. Then open the playbook skill for the item type: mtm-pi, mtm-bug, mtm-cr or mtm-task (`{{SKILLS}}/mtm-<type>/SKILL.md`). For an item you started before, start only reprints its material and names the stash to pop. If it warns that no template or no MVS came back, read `start-response.json` and build the submission with `MTM fill` from the fields the reply names. Keep `.mtm/items/<ID>/notes.md` current: root-cause hypothesis, files touched, what is left.
3. Run `MTM poll` at least every 3 minutes or every 5 tool calls while you work. When an unstarted PI race may appear, poll after every test, review, evidence or commit command (and at most two tool calls apart): PI ranking decays while you work on another item. Lines starting with `!!` are orders about the item you work on now; lines starting with `note:` are information:
   - `!! PI ... not started`: switch to it, unless NEXT says the current item must finish first. If the current item is committed and its tests pass, submit it first. Otherwise `git stash push -u -m "WIP <ID>"` and check that it printed `Saved working directory`. A PI already in progress is finished before a new PI.
   - `!! WRAP UP <ID>`: stop adding scope: commit, run evidence once on the commit, push, submit what passes its checks (the MVS for CR/BUG).
   - `!! OVER BUDGET <ID>`: this is a hard stop, not a prompt to keep debugging. Make no more product changes. If evidence is already passing, commit/push/submit now; otherwise immediately `git stash push -u -m "PARKED <ID>"`, then `MTM park <ID>`, and take NEXT. A parked item comes back only when NEXT names it, with a fresh budget.
   - `!! ABANDON <ID>` or `!! REMOVED <ID>`: the item can no longer be submitted. Do exactly what the line says: for your current item it says to stash its changes as `DEAD <ID>`; for a stashed item it says to drop its stash entry later. Never stash your current work under another item's name.
   - `!! SPEC CHANGED <ID>`: the customer changed the request; reread the brief before committing.
   - `!! MATCH PAUSED`: keep coding and testing locally; do not start or submit; `MTM watch` until RUNNING.
4. After a PI is submitted, mtm names the item it interrupted and its stash: run `git stash pop 'stash@{N}'` for that `WIP <ID>` entry. On a conflict, keep the pushed PI code, merge the WIP into it, rerun that item's tests, then `git stash drop 'stash@{N}'`. If the pop printed `could not restore untracked files`, first copy those files out of the stash (`git show 'stash@{N}^3:<path>'`). Never `git reset --hard` or `git checkout .` while a WIP stash or conflict exists. Stash entries from earlier matches are never popped.
5. After `SUBMITTED`, do not wait for grading: back to 1. Done has three levels: verified (evidence on the commit), submitted (`SUBMITTED`), accepted (Grader PASSED). Only the first two are yours. On the first FAILED result, spend at most 2 minutes checking systematic causes (branch, SHA on the remote, evidence format, build from scratch) and note them in `.mtm/notes.md`; never resubmit a FAILED item.
6. `MATCH FINISHED`: run `MTM retro` once, then stop.

## Hard rules
- `MTM start <ID>` before any work on an item: it returns the brief, the submit template and, for CR/BUG, the MVS.
- Only `SUBMITTED <ID>` is final. `SUBMIT REFUSED`: if the line says `Take NEXT`, or the item is CLOSED or past its deadline, take NEXT. Otherwise nothing was accepted: fix the cause it prints and submit again, three tries in all, then `MTM park <ID> --reason '<refusal>'` and take NEXT. `SUBMIT UNCERTAIN`: change nothing, run `MTM status`; resubmit once only if no submission is listed.
- `START REFUSED`: if it says the item is not open yet, take NEXT and come back when its state changes; otherwise retry at most once, then take NEXT (after two refusals NEXT ranks it last).
- Commit on the branch you pulled (the graded branch), push, then submit. If the push is rejected: `git pull --rebase`, rerun evidence, push, submit the new HEAD. Never force-push or rewrite pushed history.
- Fill the submission with `MTM fill <ID> 'field=text' ...`: single quotes, `''` for an apostrophe, no double quotes or backticks inside. For long text, write it to a file with apply_patch and use `'field=@path'`; for lists, numbers and booleans use `'field:=["a","b"]'`. Never edit the kit, `.mtm/ledger.json` or other `.mtm` files except `baseline.md`, `notes.md` and `items/<ID>/notes.md`.
- Game Master's clock is the only clock. Use only your team's credentials and the endpoints MTM uses. Never touch Admin or Grader APIs, never look for unrevealed items, templates or MVS, never touch other teams' data or disrupt the server.
- Minimal diff: no new dependencies, no framework or stack change, no mass reformatting, no rewrite.

## Quality bar
Grader runs more scenarios than MVS, and FAILED scores 0.
- Write each MVS as a test at the layer it names (HTTP status and fields for endpoint scenarios, component level for UI). Add edge cases: exact boundaries, just before and after, empty/null, case and whitespace, every caller of changed code. For an API response built from module-owned arrays or objects, test mutation isolation: mutate one response, call again, and prove the service data and later response stay unchanged. A new sibling route inherits harmless routing normalization (such as one trailing slash) unless the brief explicitly rejects it: do not add a restrictive 404 assumption just because it is not named. Follow exact filenames and documentation targets named by the brief; never invent an alias.
- If an existing test asserts the behaviour the item changes, update it to the new rule and name it in the submission. Never delete, skip or weaken a test.
- The full suite must show no NEW failures against `.mtm/baseline.md`. Exclude baseline failures by name in the evidence command and list them in the submission. Rerun a flaky test once; then exclude it and say so.
- Build once before submitting (the map's build command), so type errors and the app project are checked, not only the tests.
- Match file-name case exactly and use `/` in paths: the Grader may run on Linux.
- Before committing, `MTM review <ID>`: it checks the diff against the contract (scope, tests) and writes a review pack. Do what it prints (a read-only reviewer sub-agent for CR/BUG, a short self-review otherwise) and close every GAP with a test first. The builder never grades its own work by feel.
- Order: delete scratch files, review, commit, run `MTM evidence <ID> -- <command> [args...]` on the committed code, push, fill (put the contract's assumptions in the summary), submit. mtm refuses a submit when the commit differs from what the last passing run tested (a commit hook that reformats files counts as a change).

## Commits
Commit an item only when it is done and tested; paused work goes into a stash, never into a WIP commit (mtm warns when another item's commit rides along). `git status --short` first; stage only the item's files; message `<ID>: <what>`. If a commit hook rejects the message, use the repo's convention with the ID inside (`fix(BUG-01): ...`). Use `--no-verify` only when the hook needs a tool that is not installed, and say so in the submission.

## Sub-agents (only if you can spawn them)
- Read-only roles only: 2 explorers in parallel at the start of a PI (one reads the newest customer commits against the symptom, one searches the symptom words and logs; each answers in at most 10 lines with file:line), and 1 reviewer for a CR/BUG review pack. Never more than 2 at once, never for a small or tightly coupled item.
- A sub-agent never edits files, changes git state, or runs MTM start, fill, submit or ready. Keep working while it runs; if it has not answered in 3 minutes, go on without it.

## Game Master trouble
- Unreachable or HTTP 5xx: keep working on the current item and retry with `MTM watch --timeout 60`. When mtm says the match end time has passed, it prints `MATCH FINISHED`: stop.
- `DEGRADED` or `MAPPING PROBLEM`: read the item ids and texts from the page text mtm prints, and use `MTM start <ID>` / `MTM submit <ID>` with ids shown on the page. `MTM poll` and `MTM watch` still wait and report page changes. Never edit gm.config.json during the match.

## Token budget (credits break ties)
- Work from the repo map, the brief and notes. Search, then open only the needed line ranges.
- Targeted tests while iterating; the full suite once on the commit (for a PI, the repro plus the affected module when the baseline suite takes more than 3 minutes).
- Never print whole large files, logs, lockfiles, node_modules or build output.
- No narration, plans or recaps in replies. Short commit messages.
