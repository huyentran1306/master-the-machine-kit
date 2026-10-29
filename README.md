# Master the Machine Kit3 — 2.6.0

Team pack **Codex**, protocol 4, cho MTM Player. Bản 2.6.0 trên nhánh `codex/kit3_bou_v5`, phát triển từ bản 2.5.0 trên `codex/kit3_bou_v3`.

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

Chỉ tiếp tục khi checker báo **READY**. Trên MTM Player chọn provider **Codex** và load đúng workspace vừa cài. Team identity trong pack là `[FHM] Bá Khí`; metadata package/info/runtime cùng phiên bản `2.6.0`.

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

Use MTM Player **0.9.35**. Install into a fresh workspace using the Node command above (or `team-sdlc-pack/install.ps1`), then run the checker and require **READY**. In Player Init, select Codex, set the Codex CLI path to the installed **codex.exe** (absolute path), and choose the match-authorized model in Init. Keep previous match workspaces separate.

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
