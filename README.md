# Master the Machine Kit3 — 2.9.1

Team pack **Codex**, protocol 4, cho MTM Player. Bản 2.8.0 trên nhánh `codex/kit3_bou_v11`, cập nhật từ nền 2.7.7.

## Thay đổi chính

- Sửa đăng nhập báo thành công nhầm: HTTP 200 với `Loading match…` chưa chứng minh đã đọc được dữ liệu trận.
- POST đăng nhập gửi `Origin` và `Referer` cùng origin như client chính thức.
- Khi HTML chưa chứa dữ liệu, helper đọc contestant view `/api/v1/match/{matchId}` bằng cookie của đội. Endpoint này được xác minh từ JavaScript public mà trang match tham chiếu; có thể cấu hình trong `matchView.extraJsonPaths`.
- JSON trả 401/403 thì refresh thử đăng nhập lại tối đa một lần. Cookie/password/key vẫn chỉ nằm trong bộ nhớ helper.
- Không phát `ENVIRONMENT_READY` hoặc `BACKLOG_SYNC COMPLETED` khi mới đọc được loading shell. Preparation cho phép metadata xác thực chưa có UUID; khi vào GAME cần UUID để Start Work/Submit.
- Kế thừa cải tiến Kit2: checklist theo từng acceptance criterion, nhắc đổi hướng sau nhiều vòng test thất bại, và kiểm tra evidence chứa kết quả test trước khi submit.

Chi tiết xử lý portal và cách kiểm chứng: [docs/kit3-portal-recovery.md](docs/kit3-portal-recovery.md).

## Cài trên máy chạy Player

Yêu cầu Node.js >= 20, Git và Codex CLI đã đăng nhập. Từ thư mục repo, dùng một workspace mới để giữ các lượt thi cũ.

Ví dụ PowerShell trên Windows:

```powershell
node .\team-sdlc-pack\scripts\install.mjs --team-workspace "D:\mtm\BAK-Kit3"
node .\team-sdlc-pack\scripts\check-distribution.mjs --team-workspace "D:\mtm\BAK-Kit3"
```

Chỉ tiếp tục khi checker báo **READY**. Trên MTM Player chọn provider **Codex** và load đúng workspace vừa cài. Team identity trong pack là `[FHM] Bá Khí`; metadata package/info/runtime cùng phiên bản `2.8.0`.

Initialize trên Player chỉ tạo round local. Để tập lại cần mã trận mới hoặc Re-match phía BTC.

## Chạy test hồi quy portal

```sh
node --test tests/portal-recovery.test.mjs
```

Sáu test dùng HTTP server loopback, credential giả và không gọi model hay hệ thống thi thật. Bao phủ loading shell, Origin/Referer, JSON view, cookie hết hạn, từ chối readiness/sync giả và việc UUID chỉ được công bố sau Start.

## Kiểm chứng

- Bản nguồn Kit3 đã qua toàn bộ **89 test** trong devkit nội bộ; devkit đầy đủ và đề giả lập không nằm trong repo phát hành này.
- Sau cập nhật metadata `2.0.1`, 14 test portal/cài đặt/đóng gói của bản nguồn pass.
- Installer/checker của pack và `inspect-runtime` của MTM Player 0.9.32 trả **READY** cho workspace mới trên macOS.
- Sáu test portal độc lập được kèm trong repo để đội tự chạy. Các kiểm tra trên không xác nhận môi trường Windows của từng máy.

Repo chỉ chứa runtime Codex, tài liệu và fixture giả. Không đưa credential, transcript, workspace đã cài, repository đề thi hoặc log trận thật vào Git.

## Windows contest machine

Use MTM Player **0.9.44** or newer (from 0.9.44 the Game Master can refuse Init with PLAYER_VERSION_TOO_OLD; the team pack contract and progress schema are unchanged from 0.9.40; 0.9.44 also ships a Linux launcher `mtm-player.sh` + `install-team-pack.sh`). Install into a fresh workspace using the Node command above (or `team-sdlc-pack/install.ps1`), then run the checker and require **READY**. In Player Init, select Codex, set the Codex CLI path to the installed **codex.exe** (absolute path), and choose the match-authorized model in Init. Keep previous match workspaces separate.

> Nhánh `codex/kit3_tran_v2` = dòng kit của Tran dựa trên `codex/kit3_bou_v4` (B, 2.8.0); thư mục `Kit3-tran-v2-<version>`, cùng format với `Kit3-bou-v4-<version>` của B.

## Changelog — 2.9.1 (nhánh `codex/kit3_tran_v2`)
Bản trước giữ ở `Kit3-tran-v2-2.9.0` (tag `kit3-tran-v2-2.9.0`) và `Kit3-tran-v2-2.8.9` để rollback.
- **Worker tự lấy build slot, không chờ orchestrator chuyển lời.** Trận luyện tập H6GGOXRM (2/11, kit 2.8.9): worker CR-01 xin build slot qua orchestrator lúc phút 14, slot đã cấp nhưng orchestrator bận ship nên tới phút 26,9 mới báo; worker ngồi không **11 phút** cho một lần `pnpm build` chạy 2,4 giây. Giờ worker chạy `node <pack>/src/build-lock.mjs --slots N -- pnpm build`: lock là thư mục `.mtm-notes/build-slots/slot-i` của main checkout (mkdir nguyên tử trên mọi OS), tự thu hồi slot của tiến trình đã chết, không bao giờ chờ quá 5 phút (quá thì chạy luôn). Production server không cần lease.
- Cùng trận: 9/10 item nộp; mất mạng (DNS) 11:55–12:04 làm CR-02/TASK-04/CR-03 đã xong phải chờ push; CR-01 không kịp.

## Changelog — 2.9.0 (nhánh `codex/kit3_tran_v2`)
Bản 2.8.9 giữ nguyên ở thư mục `Kit3-tran-v2-2.8.9` (tag `kit3-tran-v2-2.8.9`) để rollback.
- **Effort theo từng worker, do helper quyết khi giao việc (không thêm lượt gọi model):** item chỉ trả lời (đa số TASK/PI) `low`; item sửa code (BUG/CR) `medium`; giao lại (PARKED, rollback, mất worker) `high` nếu còn ≥10 phút, ít hơn thì `medium`; item trả lời còn <4 phút vẫn `medium`. `dispatch_ready` trả `reasoningEffort` cho từng entry và orchestrator luôn truyền `reasoning_effort` (bỏ trống thì worker kế thừa effort của orchestrator). Đổi mặc định bằng `parallel.workerEffort` trong game-adapter. Model: kế thừa của orchestrator (sol).
- **Tin nhắn giao việc 1 dòng:** nội dung đầy đủ ghi ra `.mtm-briefs/<ID>/task-<taskName>.md` (đã git-ignore), tin nhắn spawn chỉ trỏ tới file đó. Lượt set4: orchestrator mất 79 giây gõ lại 3 tin nhắn ~1,5 KB sau `dispatch_ready`; giờ ngắn ~15 lần, đỡ credit output.
- Orchestrator vẫn để effort `medium` (chỉnh ở form Init của Player / `MTM_REASONING_EFFORT` của auto-rematch); hạ `low` sau khi đo.

## Changelog — 2.8.9 (nhánh `codex/kit3_tran_v2`)
- **Lưới an toàn cho item không có worker:** mỗi item giao đi lưu lại tin nhắn giao việc và "dấu vân tay" worktree (HEAD + file thay đổi). Sau 4 phút mà worktree y nguyên (không file nào đổi, không commit), view báo `!! CHECK WORKERS` và đánh thức vòng chờ; `dispatch_ready` trả `respawnCheck` kèm đúng tin nhắn cũ. Orchestrator phải `list_agents` trước: chỉ tạo lại khi KHÔNG có worker sống cho item đó (không bao giờ 2 worker một worktree). Tối đa 2 lần mỗi item; item READY/PARKED/đã integrate/đã nộp không bao giờ bị đưa lại. Trước đây một lần spawn thất bại mà orchestrator quên thử lại thì item nằm im tới hết trận.

## Changelog — 2.8.8 (nhánh `codex/kit3_tran_v2`)
Review độc lập toàn bộ thay đổi từ 2.8.0; mỗi lỗi dưới đây có test tái hiện (fail trên 2.8.7, pass trên 2.8.8).
- **Gate CODE_FAILURE tự rollback ngay trong `ship`.** Trước đây commit đỏ nằm lại trong main; item kế tiếp ship sẽ push luôn code đỏ lên origin và nằm trong bài nộp của item đó, rồi không rollback được nữa.
- **Ship lại sau khi bị preflight trả về nay lấy commit sửa của worker.** Trước đây ship bỏ qua integrate khi đã có integratedSha nên nộp lại đúng commit cũ, lặp tới hết giờ.
- **`ship force:true` / 3 phút cuối với gate ENVIRONMENT không còn bị từ chối sau khi đã push** ("no test run reported"): nộp kèm `allowUntested` và lý do. Gate GREEN mà không đọc được số test (jest) cũng vậy; giờ đọc được cả định dạng jest.
- `validate-answer` kiểm evidence bắt buộc đúng như preflight (chỉ tính mảng `evidence`).
- Gate tính "test của item" theo đúng các commit của item (`mainBefore..integratedSha`), không lẫn test của item khác.
- BACKLOG_TESTS từ ship không vi phạm luật `executed >= required` của Player.
- Liệt kê tiến trình (`ps`, PowerShell WMI) có timeout 20 s: không treo khoá helper khi `worktree remove`.
- **Log tiến độ:** sau mốc 180 KiB, lượt đọc trang trận định kỳ không còn ghi; trận 60 phút K1SLTZLK lên 224 KiB / 256 KiB, 175 KiB là các lượt đọc này.

## Changelog — 2.8.7 (nhánh `codex/kit3_tran_v2`)
- Lượt đề thật RBKTH8OM (2.8.6, sol medium): **1000/1000**, nộp cuối phút 25,7, 182,9 credit, cả 10 item nộp 1 lần là qua.
- **Nâng giới hạn luồng của Codex:** Codex multi-agent v2 mặc định chỉ cho 4 luồng mở mỗi phiên (orchestrator + 3 worker). Lượt trên `spawn_agent` bị từ chối 2 lần ("agent thread limit reached"): CR-01 chờ 1,4 phút, BUG-04 chờ 3,5 phút mới có worker. `config/codex.toml` thêm `[features.multi_agent_v2] enabled = true, max_concurrent_threads_per_session = 12` (đã thử nạp config với Codex 0.149, 0.159, 0.166). Orchestrator được dặn thử lại đúng lệnh spawn sau lần wait kế tiếp nếu vẫn bị từ chối.
- **Log tiến độ không còn cặp REQUESTED bị hở:** gần mốc 180 KiB, telemetry tuỳ chọn bị bỏ; trước đây có thể ghi REQUESTED rồi bỏ mất kết quả. Giờ đã ghi REQUESTED thì kết quả luôn được ghi, còn REQUESTED bị bỏ thì bỏ luôn kết quả (GAME_MASTER_API và MATCH_MCP).

## Changelog — 2.8.6 (nhánh `codex/kit3_tran_v2`)
- Lượt set3 (2.8.4, sol): **1000/1000**, nộp cuối phút 30.4, PI nộp sau 3,8 phút (hạng 1), mỗi đợt giao mọi item cùng lúc, gate 2–9 giây.
- **Bảo vệ test baseline không chặn nhầm item sau:** test baseline mà một item ĐÃ NỘP sửa (kèm TEST-CHANGE) không còn chặn các item nộp sau, nếu file vẫn y như bản đã nộp. Lượt set3: TASK-03/TASK-04 bị từ chối 2 lần vì thay đổi hợp lệ của BUG-01 (mất ~2 phút trên item có deadline). Sửa thêm lần nữa thì vẫn phải có TEST-CHANGE riêng.
- **validate-answer kiểm đúng như preflight nộp:** đường dẫn evidence viết dạng `answers/<ID>/...`, CR/BUG thiếu evidence, evidence bắt buộc chưa được trích (`--required`, tự điền trong message giao việc). Lượt set3: CR-01, CR-03, BUG-01 bị preflight trả về vì đúng các lỗi này.

## Changelog — 2.8.5
- **Tool `ship <ID>`:** một lần gọi helper làm trọn READY → integrate → gate → BACKLOG_TESTS (số liệu thật từ lần gate) → git push (chỉ fast-forward, không bao giờ force) → submit_work → xoá worktree. Các lần ship chạy lần lượt (không giẫm main). Dừng và trả `{stage, error, next}` ở mọi chỗ bị từ chối: CONFLICT/MAIN_DIRTY, gate CODE_FAILURE (không push, không nộp), ENVIRONMENT (thử lại hoặc `force:true` khi gần deadline), push bị từ chối, preflight nộp. Lượt set2: item READY phải chờ orchestrator 3,5–7 phút; worker CR-02 xong sau 7,7 phút nhưng nộp sau 14,9 phút.
- Gate không còn báo GREEN khi không tìm thấy trình chạy test nào; thời gian gate tối đa 90 s; `tool_timeout_sec` của MCP 300 s (ship gồm gate + push + nộp).

## Changelog — 2.8.4
- **PI / item chỉ trả lời nộp nhanh hơn:** lệnh kiểm tra đáp án có sẵn `node <pack>/src/validate-answer.mjs <submit.json> <schema>` (cùng bộ kiểm của helper) được gửi kèm trong message giao việc; worker không cần cài jsonschema/ajv. Message của item trả lời có "FAST PATH": đọc brief một lần, điền submit.json, chạy lệnh kiểm, commit, READY; không tạo evidence thừa. Lượt set2: PI-01 có đáp án ở phút 2,3 sau khi giao nhưng mất thêm 2,4 phút cài validator và viết test.log, nộp sau 6,4 phút nên về thứ 2.

## Changelog — 2.8.3
- `dispatch_ready` luôn giao TẤT CẢ item đang mở (bỏ tham số `max`). Lượt set2: orchestrator gọi `max:1` nên đợt 3 giao lần lượt ở phút 12.9 / 13.6 / 14.2 và đợt 4 ở 20.9 / 22.6 / 22.8 thay vì cùng lúc.

## Changelog — 2.8.2
- **Gate do helper chạy (tool `gate`):** vitest/tsc gọi thẳng binary trong node_modules (không qua pnpm), item có deadline chỉ chạy test của chính item, giới hạn thời gian chừa 1 phút để push + nộp. Kết quả GREEN / CODE_FAILURE / ENVIRONMENT; chỉ rollback khi CODE_FAILURE. Lượt set2 (31/10): BUG-03 READY phút 11.5, gate `pnpm test` mất 118 s, báo ELIFECYCLE dù 15/15 test đạt, `pnpm typecheck` treo, bị rollback nhầm, push phút 23.16 trễ deadline 10 giây. Chạy thẳng vitest: 1,9 s.
- **Tắt verify-deps-before-run của pnpm** cho mọi lệnh shell của agent (`shell_environment_policy` trong codex.toml), như kit 2.3.4.

## Changelog — 2.8.1
- **Giao việc ngay khi đề mở:** tool mới `dispatch_ready` chạy start_work + worktree create cho MỌI item đang mở chưa có worker trong một lần gọi, trả về sẵn `spawn[]` (taskName + message) để orchestrator spawn hết trong cùng lượt. Mọi view có cảnh báo `!! DISPATCH NOW` kèm số phút item đã mở. Lượt tập 2.8.0: CR-01 mở phút 8 mà phút 14.2 mới giao, BUG-04 mở phút 12 mà 17.9 mới giao, vì orchestrator giao từng item một giữa các lượt phục vụ worker.
- **Khôi phục nhanh khi model quá tải / phiên bị thay:** RESUME_GAME đánh dấu worktree của worker cũ là `orphaned`; `dispatch_ready` spawn lại worker trên đúng worktree (giữ commit, file chưa commit và port) với message bắt đầu bằng RESUME.
- Vòng chờ worker 45s -> 20s để thấy đợt đề mới sớm hơn.
- Kèm các sửa cho macOS (commit trước): đo RAM bằng vm_stat, dọn tiến trình bằng ps, thử mật khẩu DB rỗng; maxCodeWorkers 10.

## Changelog — 2.8.0

Written by Codex:
- Dispatch PI and answer-only TASK items immediately without a cap; compute, validate the shipped schema, commit and return READY. Code workers need at least 2.5 GiB free RAM and fewer than `parallel.maxCodeWorkers` (default 5). Preserve isolated ports and test databases.
- Submit deadline READY items before other orchestrator work. Gate answer-only items with the schema; gate deadline code with its own tests and typecheck. Share a FIFO `build_slot` queue for builds and production servers (`parallel.maxBuilds`, default 2).
- Never park for PI. Persist parked commit/worktree, remaining step and estimate; recommend resume before new work, including after submission and in `wait_for_update`. Stop worker servers on READY/PARKED and remove only processes whose command line contains that exact worktree path.
- Batch `start_work` with bounded concurrent MCP material reads. Raise read timeouts to 45 seconds and retry idempotent reads once; keep mutation retry behavior unchanged.
- Honor read-only MCP annotations, filter action verbs only in tool names, and prefetch logs even when descriptions mention a deploy service.
- Enforce headings such as “General evidence (required once)”; keep unchanged data exist-only, migrate cached entries missing `reference`, and exclude repository config files from evidence warnings.
- Validation: `node --test tests/*.test.mjs` **109/109** on Windows; fresh `os.tmpdir()` installation and distribution checker **READY**; local MTM Player 0.9.41 `verifyTeamRuntime` **VERIFIED / READY**, version 2.8.0. No live match was run.

## Changelog — 2.7.7

Found in a live 2.7.6 practice match (30/10), fixed by Claude:
- **A data file the item only asks to save is not forced into submit.json.** `submit_work` refused a finished item because the official QA data file ("save it unchanged as `answers/<ID>/evidence/<name>.json`") was not cited in any `evidence` array, costing about two minutes against an 18-minute deadline. Extracted names now carry `reference`: test-case evidence ("Required evidence: …") and "before" artifacts must be cited (error `REQUIRED_EVIDENCE_UNREFERENCED`); other strict files must exist and only warn `EVIDENCE_NOT_CITED`.
- Validation: `node --test tests/*.test.mjs` 91/91.

## Changelog — 2.7.6

- **Item text behind portal references** (Huyền, cherry-picked from `codex/kit3_tran_v1` c72d338): the live portal sends `descriptionMd:"$15"` with the text in a separate flight chunk; the helper now resolves it, reads the JSON view when items lack text, warns `NEED_DESCRIPTION` at start_work and refuses `NO_ITEM_TEXT` at submit. In a 30/10 rehearsal this was why BUG-01 scored 0.
- Validation: `node --test tests/*.test.mjs` 90/90 (85 from 2.7.5 + 5 new); fresh install + checker READY; MTM Player 0.9.41 `verifyTeamRuntime` VERIFIED.

## Changelog - 2.7.5

Written by Codex:
- Explicit required-evidence/artifact lines, sections and tables block submission when missing; incidental mentions remain CHECK_EVIDENCE warnings.
- Only anchored `answers/<ID>/evidence/` paths normalize. Explicit evidence paths accept any extension; prose filenames retain the artifact filter.
- Cached evidence without strictness is re-extracted before submission and brief/worktree reuse.
- Logs and optional MCP tools require read-only annotations or clear read verbs, with action verbs rejected. Data/search matching is preserved.
- Data, search and logs each get a first attempt before title-only retries; optional discovery shares a two-second budget within the total 30-second bound.
- Worker cutoffs reserve the existing margin without a positive floor, including when the cutoff has passed.
- Validation: 85 synthetic tests passed; fresh temporary install/checker READY.

## Changelog — 2.7.4

Found by a teammate's review (Huyền), fixed by Claude:
- **Item text from the contestant JSON view is read.** `descriptionOf` in `portal.mjs` ignored `descriptionMd`, the field that carries the full item text in the organizers' JSON view, and `minimumVerificationMd`, which names the required evidence. With only the JSON view available, items had an empty description and a worker could not see the task. Both fields are now included.
- Validation: `node --test tests/*.test.mjs` 77/77; fresh install + checker READY; MTM Player 0.9.41 `verifyTeamRuntime` VERIFIED.

## Changelog — 2.7.3

From the Group A warm-up match format (10 items in 40 minutes; deadlines of 8, 15, 15 and 18 minutes; an incident answered from production logs), fixed by Claude:
- **Deadline margin scales with the time left.** Worker stop time keeps a quarter of the remaining time (1.5-5 minutes) for integration and submission instead of a fixed 5 minutes, which left an 8-minute item about 3 minutes of work.
- **Workers get every read-only company tool's output up front.** Besides test data and knowledge-base search, the helper now calls log/observability tools and any other read-only tool it can fill arguments for, and repeats searches with the item title alone. Workers cannot query the match MCP themselves, so an incident answered from logs no longer needs a NEED_INFO round trip.
- Validation: `node --test tests/*.test.mjs` 76/76; fresh install + checker READY; MTM Player 0.9.41 `verifyTeamRuntime` VERIFIED.

## Changelog — 2.7.2

Found in a live 2.7.1 practice match (Player 0.9.41), fixed by Claude:
- **Evidence names that may block a submission must be unambiguous.** A JSON field named in prose was extracted as a required file; `submit_work` refused the item and the orchestrator created a placeholder to get past it, minutes before the item's deadline. Only an explicit `evidence/` path, a "before" artifact, or a screenshot/capture naming an image now blocks; every other mention is a `CHECK_EVIDENCE` warning that forbids placeholder files.
- **Full `answers/<ID>/evidence/<name>` paths count as evidence** (they were dropped as source paths); only artifact extensions are considered.
- **Markdown table rows are read one at a time**, so a "before" in one row no longer marks the next row's file as a before artifact.
- Validation: `node --test tests/*.test.mjs` 76/76; fresh install + checker READY; MTM Player 0.9.41 `verifyTeamRuntime` VERIFIED.

## Changelog — 2.7.1

Written by Codex. Preserve the dispatcher-only 40-minute Windows workflow; prioritize points, then speed, then credits.

- **Required evidence:** extract exact filenames and before flags into compact/full Start Work results, worker briefs and the top of each checklist. Preflight and dryRun require the files in the submitted commit and references in submit.json evidence arrays. Previously, only already-referenced files were checked. Capture before artifacts immediately on the worker's port; recover the base commit state if edits already happened. Permit exact-name extraction mistakes only through allowMissingEvidence plus a recorded reason.
- **Complete worker material:** compact mode already retained full item text, acceptance criteria, instruction, template, MVS and organizer files, but orchestrator MCP results were not transferred. Automatically discover per-item data and doc/KB search tools by purpose, preserve raw results and failures in ignored brief files, and copy them into the worktree. Bound retrieval time and preserve follow-ups through match_mcp backlogItemKey. Workers read every brief file before NEED_INFO; the orchestrator fetches missing material and resumes the worker. The old profile allowed read-only MCP calls, but did not guarantee retrieval or transfer.
- **Submission status:** refuse BLOCKED and all-NOT_RUN/FAIL/zero-case answers unless allowBlocked and a recorded reason are supplied. Reserve that override for the last minutes when nothing better exists; prefer verified DONE/PARTIAL with real evidence. Keep existing schema, baseline, verification, integration and replay safeguards.
- **Synthetic regression coverage:** test filename extraction and exclusions, committed-file/reference gates, overrides, compact/full briefs, differently named HTTP MCP tools, raw-result retention, failures, follow-ups and worker ordering. No organizer content, credentials or match records were added.

Validation on Windows: `node --test tests/*.test.mjs` — **73/73 passed**. Fresh installation under `os.tmpdir()` and the separate distribution checker both returned **READY**, including the 2.7.1 MCP handshake. No live-match performance claim.

## Changelog — 2.7.0

Written by Codex. Optimize the official 40-minute Windows match for passed points, then speed, then credits. Retain the existing source, baseline, evidence and submission safeguards.

- **Dispatcher-only game phase:** assign every startable item, including PI and late reveals, to a feature worker with `fork_turns: "none"` and a paths-only handoff. The helper ranks PI first, then nearest deadline, then points per minute, excluding occupied worktrees. Default to three workers; allow one extra PI. Configure `parallel.maxWorkers` in `team-sdlc-pack/config/game-adapter.json` before installing. Reserve provider capacity for the orchestrator, the cap, and one PI; if the provider refuses that extra slot, park a lower-priority worker. This removes the main-checkout implementation lane that delayed ready submissions, late reveals and integrations during rehearsal.
- **Whole-item workers:** workers own playbooks, reproduction, implementation, targeted/full-suite checks, required typecheck/build, organizer runners and QA data, evidence, answer, engineering record, inline checklist review and final commits. Return READY/PARKED, SHA, counts, check status, evidence paths, risks and required contradiction/test-change lines. Never call Game APIs or push. Keep checker/scout profiles only for worker-requested, read-only assistance when a spare slot and <=2 minutes are available; reserve PI capacity. This removes routine per-item reviewer overhead while preserving criterion-based review.
- **Immediate integration and submission:** integrate committed worker ranges, run one gate in main (target <=2 minutes: full suite + typecheck; build only when absent/failed in the worker or build-relevant files changed), push, submit and remove immediately. If a required check cannot fit, delegate long verification of the integrated tree; never call a timed-out gate green. Conflicts and red gates go back to a worker. Only a trivial one-line conflict may be resolved in main. A guarded rollback reverts the just-integrated, unsubmitted range, freeing main for other READY items; replay the complete failed range on retry. Preserve uncertain submission bodies/keys unchanged.
- **Deadline margin and event loop:** end worker time boxes five minutes before the earlier item deadline or match end; ask late workers to stop and return what passes. With active workers, wait natively for completion for at most 45 seconds (shorter near cutoff), then drain/check Game Master events with `wait_for_update timeoutMs:1000`. Also check events between integrations. With no workers, use the helper's 55-second long poll. Normal idle event latency is about 46 seconds plus network latency; completion wakes early. This is a sequential loop using available primitives, not an assumed cross-tool wait-any. The margin addresses the narrow deadline buffer observed in rehearsal.
- **Small orchestrator context:** `start_work` now defaults to `compact:true`, writes full material in ignored brief/files paths and returns only dispatch metadata, paths and a short summary. `compact:false` retains the full result. Read the orchestrator skill once; use only its <=30-line Quick card for reminders. Never view images or item diffs in the orchestrator; print only stats, exit codes and <=15 log-summary lines. Workers redirect long logs and view each judged screenshot at most once. Rehearsal showed that the organizer meter counted the orchestrator thread alone, repeated skill/material reads enlarged that context, and each subsequent call resent it; fewer/smaller turns also help independently of that meter behavior.
- **Concurrent environment isolation:** persist a unique port pair per worktree: dev `3100 + 2n`, production `3101 + 2n`, including PI overflow. Configure `parallel.portBase` in the same helper config. Write the pair into each brief; require server flags/environment and browser/runner URLs to use it. Keep the existing per-worktree test-DB rewrite, copy preparation notes into the brief, and remap application/checklist paths. Workers stop their processes before returning and use private dependencies before installs or client generation that would mutate a shared link.
- **Regression coverage:** add static dispatch/lifecycle contracts and synthetic runtime tests for compact/full mode, material files, deadline margin, caps, ports/DBs, queue order, committed integration, replay, conflict abort and rollback/fix-up. Version package/runtime/info consistently at 2.7.0. No organizer pages, item descriptions, team records, credentials or match transcripts were added.

Validation: pending final full-suite and fresh-install checks. No live-match performance claim.

## Changelog — 2.6.0

Written by Codex. Preserve the 40-minute match workflow; prioritize passed points, then speed, then credits.

- **Contradiction record:** orchestrator, backlog playbooks and isolated children must record `CONTRADICTION: <artifact A> vs <artifact B>; source: <authoritative source>; decision: <what was changed and why>` in the template's existing engineering record analysis/risks field. Continue with the safe, design-consistent choice. The checker reports an unrecorded resolution as a GAP, making spec/test conflicts explicit instead of encouraging silent test edits.
- **Committed baseline guard:** submit preflight and dryRun compare against the prepared revision, falling back to the first commit that added the assigned folder. Modified/deleted baseline migrations always fail. Each modified/deleted baseline test needs `TEST-CHANGE <repo-relative or folder-relative path>: <source>` in the committed answer, or must be reverted. New tests/migrations remain allowed. Exact errors and `touchedBaseline` lists identify affected paths; working-copy annotations cannot waive a committed change. Citation syntax is checked mechanically; the checker verifies that the real item, KB document or design record requires the behavior change.
- **Preparation repo map:** `recon_repo` generates `.mtm-notes/repo-map.md` once, excludes it locally from Git and returns `repoMapPath`. The bounded Node-only snapshot covers commands/app root, Next.js routes, tRPC procedures, service exports, Prisma relations/onDelete, test names, design records and generic directory counts/exports. Parsing is best-effort and cannot block preparation. Read candidate paths before searching, then confirm with `rg`; snapshots may be stale. Child briefs carry an in-scope copy.
- **BUG evidence:** run the reproduction test on unfixed code and preserve exact commands plus failing-before/passing-after output in `<ID>-repro.md`. Cite the introducing commit from folder-scoped history; stop that search after two minutes and report it unconfirmed if unresolved. Keep the existing BUG time target while making the fix verifiable.
- **Backlog titles:** prefer contestant `backlog[].title`/`backlogTitle` and flight projection data over text heuristics. Previously, the next-line fallback could consume a sample command, command text passed the title filter, and richness-based merging could favor page text. Exclude code blocks, reject commands/URLs/API endpoint text, and restrict fallback to the item's block. Regression fixtures use invented text; external references were read only for structure and were not copied into this public repository.

Validation on Windows: `node --test tests/*.test.mjs` — **52/52 passed** (38 existing, 14 new). Fresh installation under `os.tmpdir()` and the separate distribution checker returned **READY**, including the 2.6.0 MCP handshake. No live-match performance claim.

## Changelog — 2.5.0

Written by Codex from the 2.1.0 baseline after reviewing the Claude-written 2.1.1–2.4.0 commits and diff on `codex/kit3_bou_v3`. That branch was not modified or merged. The v1 match workflow is retained except for the changes below; 2.5.0 has not been measured in a live match.

- Retained v3's useful ideas: `fork_turns: "none"`, brief paths instead of copied context, per-item submission locks, source-based trap handling, scoped Git review and new migrations for schema fixes.
- Rewrote every child profile with the same compact source-of-truth, organizer-resource, evidence, scope and PowerShell rules. V3's checker/scout lacked parts of those rules; a child without parent history must be able to act independently. Every backlog playbook now carries the same trap policy, outside the numbered loop. Generic permission to fix tests does not prove that intended behavior changed.
- Worktree briefs and organizer copies now live under `<matchRoot>/.mtm-briefs/<ID>/`, with returned absolute paths and local Git exclusions. This avoids exceptions to child read scope. The writer preserves file contents and relative imports, rejects unsafe paths, and includes item text, startInstruction, MVS and template.
- Review explicitly includes untracked tests/migrations and named baseline fixes; scout history and PI briefs include checkoutRoot and folder. Schema fixes update both `.prisma` and a new migration, review SQL before deploy, and never accept reset prompts. Documented a fallback when `migrate dev --create-only` refuses non-interactive use.
- Reimplemented per-item submit refusal and bounded the whole asynchronous path: 20 s preflight, at most 60 s for HTTP/retries/status checks, and 5 s final refresh. V3 only lowered a retry setting; request timeouts and refresh waits could still overrun the 120 s tool timeout. Timed-out submissions retain their body/key for replay, never recommit.
- Oversized results use a valid JSON envelope whose final escaped length is bounded; short outcome/receipt/end-control fields survive. V3's envelope stayed parseable but escaping could exceed its size cap.
- Added static contract checks plus runtime tests for worktree creation/ignoring, concurrency, lock cleanup, replay, deadlines and JSON truncation. Package/runtime/info versions agree at 2.5.0.

Validation on Windows: `node --test tests/*.test.mjs` — **38/38 passed** (18 existing, 20 new). A fresh workspace under `os.tmpdir()` passed installation; both `scripts/install.mjs` and a separate `scripts/check-distribution.mjs` run printed **READY**, including the MCP handshake for 2.5.0.

## Changelog — 2.1.0

- Team name `[FHM] Bá Khí`; aligned package/runtime/info version.
- Sparse, blob-filtered clone of the assigned folder and explicit match scope isolation.
- Committed answers validated against delivered organizer schemas before submit or dry-run.
- Windows process/User DB password handling and explicit Prisma generation before seed/build/test.
- Auto-compaction threshold of 120000 tokens, preserved by installation and checked against the expanded config.

Validation: `node --test tests/portal-recovery.test.mjs tests/windows-contest.test.mjs` — 18 tests pass on Windows, including a fresh install under `os.tmpdir()` and the pack checker (MCP handshake included) returning READY.
