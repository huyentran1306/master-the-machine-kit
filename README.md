# Master the Machine Kit3 — 2.1.1

Team pack **Codex**, protocol 4, cho MTM Player. Nhánh `codex/kit3-portal-recovery` chứa bản Kit3 để đội so sánh với `main`.

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

Chỉ tiếp tục khi checker báo **READY**. Trên MTM Player chọn provider **Codex** và load đúng workspace vừa cài. Team identity trong pack là `[FHM] Bá Khí`; metadata package/info/runtime cùng phiên bản `2.1.1`.

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

## Changelog — 2.1.1

- Token reduction for subagents. In a Windows practice run of 2.1.0 (1000/1000), the match used ~25.7M input tokens: main agent 13.3M, three subagent sessions ~10M, approval guardian 2.5M. Each subagent began with ~67-70k tokens of context because `spawn_agent` defaults to `fork_turns: "all"` and copies the whole parent conversation.
- Skills now spawn every subagent with `fork_turns: "none"` and a self-contained brief (IDs, absolute paths, checklist path, diff/test commands, MVS names, evidence paths, time box); long material is written to `.mtm-notes/` and passed as paths.
- Worker, quality-checker and scout profiles forbid nested `spawn_agent` and read the files named in their brief.
- When to review or parallelize is unchanged. Not yet measured in a live match.

## Changelog — 2.1.0

- Team name `[FHM] Bá Khí`; aligned package/runtime/info version.
- Sparse, blob-filtered clone of the assigned folder and explicit match scope isolation.
- Committed answers validated against delivered organizer schemas before submit or dry-run.
- Windows process/User DB password handling and explicit Prisma generation before seed/build/test.
- Auto-compaction threshold of 120000 tokens, preserved by installation and checked against the expanded config.

Validation: `node --test tests/portal-recovery.test.mjs tests/windows-contest.test.mjs` — 18 tests pass on Windows, including a fresh install under `os.tmpdir()` and the pack checker (MCP handshake included) returning READY.
