# master-the-machine-kit

Team pack thi Master the Machine (provider **Codex**), bản 1.0.0 theo technical guide 0.5.1.
Bản này thay cho kit 0.3.x trước đây (lịch sử cũ vẫn còn trong Git).

## Cấu trúc
```
team-sdlc-pack/   Team pack mtm-player load: profile agent, skill, MCP helper (Node built-ins), installer, checker
docs/             mtm-kit-flow-va-giai-phap.html / .pdf: flow chi tiết trong trận + giải pháp cho các lỗi review
```
Hướng dẫn cài, đóng gói và các bước trong trận: xem `team-sdlc-pack/README.md`.

## Ghi chú
- Repo chỉ chứa bộ Codex. Bộ Claude Code được sinh tự động từ bộ này, và devkit (mock Game Master, player-sim, test) nằm ở máy phát triển, không đưa lên đây.
- `team-sdlc-pack/team-pack-info.json` đang để placeholder (`YOUR_TEAM_ID`): điền mã đội và tên đội thật trước khi đóng gói.
- Không commit credential, log trận thật hay tài liệu riêng của BTC.
