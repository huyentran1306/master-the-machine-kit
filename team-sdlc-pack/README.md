# team-sdlc-pack 2.7.7 — Digital Project Team (Codex, MTM technical guide 0.5.1)

Team pack chính thức để thi Master the Machine: mtm-player load pack này, chạy Codex CLI với `team_orchestrator` làm root agent, MCP Helper (`mtm_minimal`) giữ credential trong bộ nhớ, gọi Game API và ghi `progress.ndjson`.

2.7.2: only unambiguous evidence names (explicit evidence/ paths, before artifacts, requested screenshots) block submission; other mentions are CHECK_EVIDENCE warnings, never placeholders. 2.7.1: enforce required named evidence and references at submission; capture before artifacts before edits. Fetch per-item MCP data/docs into worker briefs automatically; request missing information with NEED_INFO and refuse BLOCKED/all-unrun answers without a reasoned last-minute override. Retain dispatcher-only operation, three workers plus one PI, isolated ports and bounded integration. Configure `parallel.maxWorkers` and `parallel.portBase` in `config/game-adapter.json`. See the orchestrator Quick card and [runtime details](docs/README.md).

Inherited safeguards: record contradictions and authorized baseline test changes in existing answer fields; refuse changes to baseline migrations; read the ignored preparation repo map before searching; preserve BUG reproduction output before/after and cite the introducing commit; prefer structured backlog titles over page samples. `recon_repo` returns `repoMapPath`; submit preflight/dryRun returns `touchedBaseline` and exact repair instructions.

## Cấu trúc
```
package.json  team-pack-info.json  team-runtime.json  install.ps1  README.md
agents/        team-orchestrator.toml (team_orchestrator) + team-repo-scout / team-feature-worker / team-quality-checker
config/        codex.toml (MCP registration, installer chỉ expand path), game-adapter.json (login/polling/planner)
contracts/     progress-event.schema.json (đúng schema của BTC), final-result.schema.json
skills/        team-orchestrator, game-preparation, team-recovery, backlog-pi|bug|cr|task, evidence-and-answer
bin/ src/      MCP Helper (Node built-ins, không dependency)
scripts/       install.mjs, check-distribution.mjs
docs/          README nội bộ, AGENTS.workspace.md
```

## Trước khi cài (bắt buộc)
1. Sửa `team-pack-info.json`: `teamId` = mã đội BTC cấp (không phải UUID), `teamName` = tên đội. Giữ đúng 4 field.
2. `version` phải giống nhau ở `package.json`, `team-runtime.json`, `team-pack-info.json`.
   (Dùng `node ../../devkit/tools/set-identity.mjs --team-id <ID> --team-name "<Tên>" [--version 1.0.1]` để sửa cả 3 file một lần.)

## Cài và kiểm tra (Windows, PowerShell 7)
```powershell
pwsh -NoProfile -File .\install.ps1 -TeamWorkspace "D:\mtm\<TEAM_ID>"
node .\scripts\check-distribution.mjs --team-workspace "D:\mtm\<TEAM_ID>"
```
Checker phải in `READY`. Sau mỗi lần sửa pack: cài lại. Không cài lại vào workspace đang có trận chạy.
Đóng gói: `node ..\..\devkit\tools\make-zip.mjs` → `dist/team-pack-<TEAM_ID>-<version>.zip` + `.sha256`.

## Luồng trong trận
- PREPARE_GAME_V2 → `configure_session` → GIT_AUTH/REPOSITORY/ENVIRONMENT/BUILD → `login_match` → `report_ready` (ENVIRONMENT_READY) → kết thúc lượt bằng JSON.
- START_GAME_V4 → `configure_session` (BACKLOG_SYNC + DISCOVERED) → vòng lặp: `start_work compact:true` → `worktree create` → worker (code/tests/evidence/answer/self-review/commit) → integrate + bounded gate → push → `submit_work` (1 lần, có receipt mới log SUBMITTED) → `wait_for_update` khi rảnh. Không bao giờ kết thúc lượt khi trận còn chạy.
- RESUME_GAME_V1 → reconcile log/Git/receipt, replay submit dở dang cùng idempotency key.
- MATCH_PAUSED_V1 / MATCH_ENDED_V1 → dừng ngay.

## Cần kiểm chứng ở Practice Match (26/10)
- Load team pack: identity/version hiển thị đúng; 4 profile được chấp nhận (nếu Player đòi 5 profile kiểu sample pack thì xem `Kit/README.md` mục "Profile").
- Login: helper tự thử NextAuth → HTML form → JSON API. Strategy chạy được sẽ hiện trong kết quả `login_match`; ghim lại trong `config/game-adapter.json` (`login.strategy`).
- Trang `/match/<id>`: `refresh_match` phải thấy item, status, thời gian còn lại và match UUID (từ URL Start work/Submit). Nếu `parse` báo không rõ cấu trúc: lưu HTML bằng `devkit/tools/probe-portal.mjs` và chỉnh parser.
- Progress log: `node devkit/tools/validate-log.mjs <TeamWorkspace>\team-sdlc-pack\logs\<matchId>.progress.ndjson`.
