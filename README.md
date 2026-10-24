# dpt-kit 0.3.2: Digital Project Team cho Master the Machine

Bộ AI chơi Vòng Thực chiến trên Codex. Phân tích luật: [../PHAN_TICH_VA_CHIEN_LUOC.md](../PHAN_TICH_VA_CHIEN_LUOC.md). Hồ sơ giải pháp, kết quả review và phần ADLC: [../MTM_Solution_Review.html](../MTM_Solution_Review.html). Thay đổi của bản này: [CHANGELOG.md](CHANGELOG.md).

## Thành phần

```
dpt-kit/
  codex/AGENTS.md          "não": vai trò, vòng lặp trận, Task Contract, review, sub-agent, cảnh báo !!, luật cứng, token
  skills/mtm-pi|bug|cr|task/SKILL.md   playbook theo loại backlog
  tool/mtm.mjs             "tay": CLI nói chuyện với Game Master, sổ cái .mtm/ theo từng trận, các chốt chặn
  tool/hooks.mjs           hook Codex: giữ agent chạy tới hết trận (Stop), chặn lệnh làm mất việc (PreToolUse), nhắc resume (SessionStart)
  tool/lib/                planner, adapter Game Master, git, recon, bộ chạy evidence, adlc (contract, review, retro)
  tool/gm.config.json      lớp kết nối Game Master: sửa file này khi có tài liệu BTC
  official-team-pack/      scaffold tích hợp mtm-player chính thức: agent roles, progress log, config template
  codex/LAUNCH_PROMPT.md   prompt bắt đầu trận, giải quyết xung đột với AGENTS.md trong repo
  mock/                    Game Master giả lập + repo khách hàng luyện tập (TASK, BUG, CR, PI)
  install.mjs              cài AGENTS.md + skill + hook vào ~/.codex (giữ nội dung cũ, gỡ được)
  test/                    test planner, adapter, bộ chạy lệnh, đề tập, chống dừng, ADLC, hook, bộ cài, end-to-end
```

Yêu cầu: Node 18 trở lên, git, Codex CLI. Không cần thư viện ngoài.

Windows: xem [WINDOWS.md](WINDOWS.md) để cài và chạy rehearsal bằng PowerShell. Bản 0.3.2 có `run-rehearsal.ps1`; không dùng shortcut Bash `~/mtm-rehearse` từ máy macOS cho máy Windows.

## Cập nhật sau technical briefing 23/10: mtm-player là controller chính thức

Những gì BTC đã xác nhận qua technical guide được ghi lại trong [official-team-pack/README.md](official-team-pack/README.md). Thay đổi kiến trúc quan trọng:

- `mtm-player` launch/monitor Team Orchestrator; không phải mock launcher của kit.
- Chỉ sau `MATCH_LOGIN` và `ENVIRONMENT_READY` (request id, repo, revision, build PASS, match login PASS), team mới báo `PREPARED` và **chờ player công bố `IN_PROGRESS`**.
- Khi vào trận: đọc match → `BACKLOG_SYNC` và ghi `DISCOVERED` cho từng item công khai → Start Work chính thức → mới materialize source template/scenario.
- Reference structure của BTC có Team Orchestrator và bốn specialist: Business Analyst, Developer, Cyber Security, Tester; có MCP helper và append-only `progress.ndjson` để player theo dõi.

`official-team-pack/` là bản scaffold an toàn cho sequence này. Nó cố ý không gọi những API/schema BTC chưa công bố. Chỉ dùng nó để chuẩn bị và kiểm tra structure; chưa thay `tool/gm.config.json` khỏi `REHEARSAL_ONLY`.

### Điểm và chiến lược vận hành mới xác nhận

- Tối đa 1.000 điểm chính thức. Mỗi backlog item chỉ submit một lần và phải Start Work trước; deadline quá hạn không submit được.
- Receipt của Game Master chỉ là nhận bài; Grader mới quyết định `PASSED` / `FAILED`.
- Mỗi lần cần người chạm máy bị trừ 50 điểm chính thức. Do đó giữ agent sống/resume và preflight trước Start có giá trị trực tiếp.
- Nếu bằng điểm: thời điểm hoàn thành item cuối sớm hơn và mức tiêu thụ Codex credit thấp hơn là chỉ số phụ. Không đổi code để "tối ưu điểm phụ" trước khi bảo đảm PASSED.
- Nhận xét văn hoá do Ban Giám khảo quyết định; không cộng vào điểm chính thức.

## ADLC trong kit (workshop 21/10)

Luật chấm chỉ tính điểm Grader, thời gian và credit, nên kit lấy những phần ADLC làm tăng tỉ lệ PASSED và giảm rủi ro, bỏ phần nghi thức (người duyệt từng cổng là không thể vì trong trận không ai được chạm máy).

| Pha ADLC | Trong trận | Trong kit |
|---|---|---|
| Intent | đọc đề, điều tra (PI) | `start` in brief + MVS; PI ghi `fact:` / `guess:` / `unknown:`, 2 explorer chỉ đọc nếu có sub-agent |
| Specify & Plan | Task Contract | `start` tạo `.mtm/items/<ID>/contract.md`, điền sẵn MVS; agent thêm kịch bản ẩn, scope, điều kiện dừng, giả định |
| Design | chọn cách sửa | ghi một dòng trong notes (bỏ phần 1 đến 3 phương án vì tốn thời gian) |
| Generate | code + test | playbook theo loại, test trước |
| Validate | người làm khác người duyệt | `mtm review` đối chiếu diff với contract (ngoài scope, thiếu test) và tạo review pack cho reviewer chỉ đọc; evidence gắn với nội dung commit |
| Deploy | nộp bài | `submit` qua mọi chốt chặn; Done 3 mức: verified, submitted, PASSED |
| Observe | sau trận | `mtm retro`: phút thật so với ước tính, item FAILED, item bỏ lỡ, gợi ý chỉnh `estMinutes` |
| Govern | xuyên suốt | hook Stop giữ agent chạy, hook PreToolUse chặn force push, reset --hard, sửa sổ cái, gọi Admin/Grader |

## Cài lên máy thi

```powershell
cd "<thư mục giải nén>\dpt-kit"
npm test                 # toàn bộ suite phải xanh
node install.mjs         # ghi vào %USERPROFILE%\.codex: runtime ổn định, AGENTS.md, skills\mtm-*, hooks.json
codex                    # mở một lần, gõ /hooks, review và trust 3 hook "MTM" rồi thoát
```

- Runtime được copy vào `%USERPROFILE%\.codex\mtm-kit\0.3.2`, nên có thể di chuyển hoặc xóa thư mục giải nén sau khi cài. Mỗi skill có ownership marker; nếu đã có thư mục `mtm-*` không thuộc kit, installer đổi tên nó thành `.bak-before-mtm-*` thay vì ghi đè. Uninstall chỉ xóa thư mục có marker của kit.
- `AGENTS.md` cũ được giữ nguyên, phần MTM nằm giữa hai marker; lần cài đầu có bản sao `AGENTS.md.bak-before-mtm`. Nếu có global `AGENTS.override.md`, bộ cài cảnh báo vì Codex sẽ không đọc global AGENTS.md của kit.
- Codex nạp `AGENTS.md` trong repo sau global AGENTS.md, nên file trong repo có thể override kit. Game Player phải dùng nội dung [codex/LAUNCH_PROMPT.md](codex/LAUNCH_PROMPT.md) làm prompt khởi động để xác định rõ: repo quyết code style/build/test, launch prompt quyết vòng đời trận, tự chủ, git an toàn và submission.
- `hooks.json` cũ được giữ, kit chỉ thêm 3 handler của mình (nhận diện bằng đường dẫn `tool/hooks.mjs`). Codex chỉ chạy hook đã được trust: **phải vào `/hooks` trust một lần** sau mỗi lần cài lại. Nếu Game Player chạy Codex với `--dangerously-bypass-hook-trust` thì không cần bước này. Không muốn hook: `node install.mjs --no-hooks`.
- Hook chỉ có tác dụng trong repo đang có trận (`.mtm/match.json`), các dự án khác trên máy không bị ảnh hưởng. Hook giữ phiên chỉ bật sau `mtm ready`; trước đó (lúc chuẩn bị, người còn ngồi máy) agent dừng bình thường. Tắt khẩn cấp: biến môi trường `MTM_KEEPALIVE=0`.
- Cài vào mọi Codex home có thể chạy trận (của Game Player, của tài khoản dự phòng): `node install.mjs --codex-home <dir>`. Gỡ: `--uninstall`. Thử không ghi: `--dry-run`.
- Trước lệnh đầu tiên, agent in một dòng `MTM-KIT 0.3.2`: nhìn thấy dòng này là biết bộ hướng dẫn đã được nạp. Hook ghi probe vào `.mtm/hook-probe.json`; `mtm doctor` chỉ báo `Codex hook probe: OK` khi đã quan sát thấy hook chạy trong phiên hiện tại.

## Cấu hình Codex (đội tự quyết theo hướng dẫn BTC)

Trong trận không có người bấm duyệt, nên agent phải được tự chạy lệnh và có mạng (để `git push` và gọi Game Master). Bộ kit không đặt sẵn các quyền này: đội cấu hình theo hướng dẫn Game Player của BTC. Lưu ý:

- Nên dùng mức reasoning vừa phải (medium) khi thi; `xhigh` chậm và tốn credit.
- Sub-agent (multi-agent) nếu Codex của máy thi cho phép: kit chỉ dùng vai trò chỉ đọc (2 explorer cho PI, 1 reviewer cho CR/BUG), tối đa 2 cùng lúc. Không bật được thì agent tự review theo review pack.
- Codex có bộ lọc biến môi trường: biến có tên chứa KEY, SECRET, TOKEN có thể không tới được mtm. Cách chắc ăn: `mtm init --token <token>` (lưu trong `.mtm/session.json`, đã bị git bỏ qua).
- Kiểm tra bằng cách để chính agent chạy `mtm doctor` trong đúng chế độ Game Player khởi tạo. Phải ra `doctor: OK`.

## Checklist máy thi (trước mỗi trận)

1. Clone mới repo của trận (mỗi vòng có thể đổi repo và stack). mtm tự cất state của trận cũ khi `mtm init --match <id mới>`, nhưng clone mới vẫn an toàn nhất.
2. Cắm sạc, tắt sleep và hành động gập máy, tạm dừng Windows Update, tắt thông báo, chỉ một mạng.
3. `codex --version` chạy được; `/hooks` đã trust 3 hook MTM; `git config core.longpaths true`; có `rg` (không có thì agent dùng `git grep -n`).
4. Cài sẵn toolchain theo stack của vòng (JDK + Maven, .NET SDK, Python, Node...): `mtm doctor` báo thiếu gì.
5. Chuẩn bị tài khoản Codex dự phòng (đã cài kit và trust hook). Hết $50 thì chỉ đổi tài khoản (không bị phạt), agent tự làm tiếp nhờ sổ cái `.mtm/` và hook SessionStart.
6. Prompt Game Player dùng [codex/LAUNCH_PROMPT.md](codex/LAUNCH_PROMPT.md), đã điền match ID và Game Master. Thẻ sửa nhanh 5 phút (khi buộc phải vào máy, -50 điểm): mở cửa sổ Codex, chạy `mtm doctor`, gửi prompt `Resume the MTM match: run MTM doctor and follow "Resume after a restart".`
7. Sau trận: `mtm retro`, đọc `.mtm/retro.md`, mỗi lỗi lặp lại thành một luật trong AGENTS.md hoặc playbook, chạy `npm test`, cài lại.

## Khi có tài liệu kỹ thuật của BTC

Mọi thứ phụ thuộc API nằm trong `tool/gm.config.json`:

- `endpoints`: đường dẫn HTTP cho `match`, `start`, `submit`, `ready` (biến `{matchId}`, `{itemId}`), hoặc `{ "exec": "game-player submit {itemId}" }` nếu Game Player có CLI (body JSON qua stdin, stdout phải là JSON, có timeout).
- `map`: vị trí từng trường (dạng `a.b.c`; chuỗi rỗng là cả response). `items` có thể là mảng hoặc object.
- `states`: tên trạng thái kết thúc, tạm dừng, và các trạng thái nộp bài được tính là "đã nộp".
- `submit`: trường SHA, nhánh được chấm (`gradedBranch`), loại item cần evidence, giá trị "chấp nhận", mẫu câu báo "đã nộp rồi".
- `planner`: số phút ước tính mỗi loại, ngưỡng WRAP UP, hệ số budget.

Config mặc định có `"adapterStatus": "REHEARSAL_ONLY"`; `doctor` từ chối dùng nó với Game Master không phải localhost. Chỉ đổi thành `VERIFIED` sau khi đã map API/CLI thật và chạy rehearsal end-to-end thành công. Sau khi sửa source `tool/gm.config.json`, chạy lại `npm test` và `node install.mjs` để cập nhật runtime versioned mà Codex thật sự gọi.

Kiểm tra: `mtm status --raw` (JSON thật), `mtm doctor` (báo `MAPPING PROBLEM` nếu map sai), `mtm status`. Câu cần hỏi BTC ở buổi demo 23/10:

1. Game Player khởi tạo Codex thế nào (interactive hay exec), đưa match id, URL, token ra sao? Sau khi đổi tài khoản thì ai khởi động lại agent? Hook của Codex (`~/.codex/hooks.json`) có được dùng không?
2. Trang `/match/<id>` có API JSON không? Trạng thái VISIBLE và OPEN khác nhau thế nào? Deadline là mốc tuyệt đối hay thời gian còn lại?
3. Start working và submit gọi thế nào, trả về gì khi thành công, khi trùng, khi bị từ chối? Template và evidence có dạng gì? Theo thể lệ PI không có MVS; template thật có yêu cầu evidence cho PI hay không?
4. Báo "ready" thế nào? Grader chấm nhánh nào, chạy lại cả bộ test hay chỉ kịch bản của item? Mỗi trận dùng clone mới hay clone cũ? Codex trên máy thi có bật sub-agent không?

## Lệnh `mtm`

Gọi bằng `node tool/mtm.mjs <lệnh>` từ trong repo của đội (hoặc đặt `MTM_REPO`). Mọi lệnh có kết nối đều in các dòng cảnh báo `!!` (PI chưa bắt đầu, WRAP UP, OVER BUDGET, ABANDON, SPEC CHANGED, MATCH PAUSED).

| Lệnh | Việc |
|---|---|
| `init --base-url U --match ID [--token T]` | lưu thông số trận; mã trận mới thì cất state cũ vào `.mtm/archive/` |
| `doctor` | kiểm tra config, quyền ghi .git, quyền push lên nhánh được chấm, user git, nhánh tụt/lệch so với remote, toolchain, hook, Game Master; khi chạy lại giữa trận thì báo `RESUMING`, item hiện tại, stash |
| `recon` | in và lưu bản đồ repo: các module (tới 2 cấp thư mục), lệnh install, build, test, chạy 1 test |
| `ready` | báo sẵn sàng; từ lúc này hook giữ phiên được bật |
| `status [--raw]` | sự kiện mới, cảnh báo, bảng item, `NEXT` |
| `poll` / `watch [--timeout 240] [--interval 5]` | một lần xem / chờ tới khi có thay đổi đáng kể; hết trận in `MATCH FINISHED` (exit 3) |
| `start <ID>` | Start working, lưu brief (kèm mọi trường khác của đề), template, MVS và khung Task Contract vào `.mtm/items/<ID>/` |
| `review <ID>` | đối chiếu thay đổi của item với contract: contract còn trống, file ngoài scope, chưa có test; ghi `review-pack.md` cho reviewer chỉ đọc |
| `evidence <ID> [--cwd <module>] -- <lệnh> [tham số...]` | chạy kiểm tra trên commit (CI=true, giữ nguyên tham số; chương trình .exe được gọi thẳng, không qua cmd.exe; quá giờ thì kill cả cây tiến trình), lưu log, gắn với nội dung code |
| `fill <ID> 'field=text' 'field=@file' 'list:=[...]'` | điền `submission.json` không cần sửa JSON bằng tay (hiểu cả `checks[0].name`) |
| `submit <ID> [--dry-run]` | nộp một lần, qua mọi chốt chặn; tự gắn `gitRevision` |
| `park <ID> [--reason R]` | tạm gác một item (NEXT xếp cuối); `start` lại để làm tiếp |
| `mark <ID> --started\|--submitted` | ghi nhận việc đã làm bằng công cụ của BTC |
| `report` | số phút mỗi item và trung vị theo loại |
| `retro` | sau trận: `.mtm/retro.md` với bảng item, tín hiệu cần học, gợi ý chỉnh `estMinutes` |

## Tập dượt với Game Master giả lập

Repo luyện tập `voucher-service` có 4 item: TASK-01 (100 điểm), BUG-01 (200), CR-01 (300, mở ở phút 5, hạn 20 phút), PI-01 (400, mở ở phút 12, hai đội "đối thủ" giả lập xong ở phút 7 và 11 sau khi đề mở). Mỗi item có hidden test rộng hơn MVS.

```powershell
cd "<thư mục giải nén>\dpt-kit"
node mock/setup-rehearsal.mjs rehearsal                                  # rehearsal\remote.git + rehearsal\workspace
node mock/gm-mock-server.mjs --remote rehearsal/remote.git --port 4010   # cửa sổ riêng; trận chưa chạy
```

Mở Codex trong `rehearsal\workspace`, gửi prompt khởi động như Game Player sẽ làm:
`Match demo. Game Master: http://127.0.0.1:4010, match id demo. Prepare, then play the match.`
Khi agent báo sẵn sàng, bấm giờ: `Invoke-RestMethod -Method Post http://127.0.0.1:4010/admin/start`.

Lệnh quản trị của mock: `/admin/start`, `/admin/pause`, `/admin/resume`, `/admin/reveal/<ID>` (mở đề sớm), `/admin/edit/<ID>` (sửa đề giữa trận, body JSON `{"description": "..."}`), `/admin/state` (log + điểm). `--time-scale 2` cho trận nhanh gấp đôi, `--token <t>` để bắt buộc header Bearer. Lưu ý: hook guard chặn agent gọi `/admin/` trong trận, nên các lệnh này chỉ chạy từ cửa sổ PowerShell của người.

Điểm cần quan sát khi tập: agent có điền contract trước khi code, có chạy `review` trước commit, có tự dừng giữa trận không (nếu hook đã trust thì sẽ thấy dòng `MTM keep-alive:`). Sau mỗi buổi tập: `mtm retro`, `.mtm\journal.md`, `/admin/state`, và credit đã dùng. Tập lại từ đầu: xóa thư mục `rehearsal` rồi chạy lại hai lệnh trên. Đề tập chỉ có 4 item trên repo nhỏ, nên thời gian đo được sẽ đẹp hơn trận thật.

### Trận luyện tập 02 — 10 đề, đủ 1.000 điểm

Scenario [mock/scenarios/training-02/](mock/scenarios/training-02/README.md) có 4 TASK, 3 BUG, 2 CR và 1 PI mở qua chín đợt công bố. CR/BUG chỉ nhận MVS sau Start working; TASK/PI không có MVS; PI đua thứ hạng với ba đối thủ giả lập. Mỗi đề có hidden grader và reference-fix test độc lập.

```powershell
cd "<thư mục giải nén>\dpt-kit"
npm run rehearsal:training:setup
npm run mock:training -- --time-scale 4
```

Mở Codex trong `rehearsal-02\workspace` bằng nội dung [START_PROMPT.md](mock/scenarios/training-02/START_PROMPT.md), rồi từ terminal của người điều khiển gọi `POST http://127.0.0.1:4020/admin/start`. Bỏ `--time-scale 4` để tập đúng 40 phút thật.

### Một lệnh, không cần đứng máy (chỉ rehearsal)

Sau khi đã đăng nhập Codex CLI, có thể chạy toàn bộ rehearsal mock bằng một lệnh:

```powershell
npm run rehearsal:autoplay
```

Launcher tạo một workspace mới, chạy `codex exec` với quyền workspace-write tự duyệt, đợi agent gửi `READY`, rồi **controller của mock** mới POST start clock. Game Player không biết hay gọi Admin API. Nếu một lượt `codex exec` kết thúc khi match vẫn còn chạy, controller tự chạy lượt tiếp theo từ ledger; final message của từng lượt được lưu ở `codex-turn-*.final.md`. Mặc định scale 1 (40 phút thật, dùng để đo điểm sát trận); dùng `npm run rehearsal:autoplay -- --time-scale 4` chỉ cho smoke-test nhanh khoảng 10 phút, không dùng điểm đó để dự báo kết quả thi. Kết thúc launcher tự chạy coach và in đường dẫn dashboard. Đây chỉ là automation của mock local; trong trận chính thức, Game Player do BTC cung cấp phải là bên start agent/timer theo tài liệu của BTC.

### Coach observer — đo thời gian và readiness

Sau khi cài kit, có thể mở một Codex chat thứ hai trong cùng `workspace` với [codex/COACH_PROMPT.md](codex/COACH_PROMPT.md). Coach chỉ đọc `.mtm/`, không gọi Game Master hay sửa code, nên không đụng luồng Game Player. Coach chạy:

```powershell
node "$env:USERPROFILE\.codex\mtm-kit\0.3.2\tool\mtm.mjs" coach
```

Lệnh ghi `.mtm/coach.html` và `.mtm/coach.json`: biểu đồ server-clock reveal → Start working → submit → deadline, thời gian làm so với estimate, evidence/review cho CR/BUG, điểm và sáu readiness gates. Nó chỉ kết luận `READY TO COMPETE` sau khi trận kết thúc, mọi gate pass, đạt ít nhất 80% điểm visible, và có ít nhất hai mẫu thời gian với median lệch không quá 30% so với plan; trước đó trạng thái là `COLLECTING REHEARSAL DATA`.

## Kit chưa làm (cố ý hoặc chờ dữ liệu)

- Launcher tự khởi động lại Codex khi tiến trình chết hẳn: hook chỉ giữ được lượt khi Codex còn sống.
- Profile Codex (model, reasoning, sandbox): đội đặt theo hướng dẫn BTC.
- Nhiều agent cùng sửa code song song (worktree): slide ADLC cũng cảnh báo "parallelization too soon"; chờ số liệu Training Camp.
- Đề tập 10 item trên repo cỡ thật, adapter cho dạng API thật: làm khi có tài liệu và server luyện tập.

## Test của bộ kit

`npm test` chạy toàn bộ suite sau (không ghi cứng số lượng để tài liệu không lệch khi thêm test):

- `planner`: thứ tự ưu tiên, bảo vệ việc sắp hết hạn khi PI chen ngang, PI đang làm trước PI mới, việc "chật thời gian", gác việc, cảnh báo, sự kiện sửa đề và rút đề.
- `gm-client`: map tùy biến, lỗi map, đồng hồ từ header Date, kết quả nộp (chấp nhận, từ chối, trùng, không rõ), kết quả start, adapter exec, kiểm tra ô trống.
- `run`: tham số có dấu cách, `|`, `&`, dấu nháy đi qua cmd.exe nguyên vẹn; lệnh treo và tiến trình cháu bị kill đúng giờ.
- `scenario`: mỗi hidden test FAIL trên code gốc và PASS khi sửa đúng item đó.
- `training-scenario` và `training-start`: trận training-02 đúng 40 phút/1.000 điểm, mười reference fix độc lập, wave đầu và Start working trả MVS đúng loại item.
- `liveness`: các đường từng làm agent dừng hoặc kẹt (DEGRADED, mất kết nối sau giờ, doctor khi resume, start lại, fill).
- `adlc`: contract điền sẵn MVS và còn "mở" tới khi agent điền; kiểm tra scope theo thư mục và glob, file test không bao giờ bị tính ngoài scope; retro.
- `hooks`: ngoài trận không làm gì; lúc chuẩn bị không giữ phiên; sau `ready` và giữa trận biến lượt kết thúc thành lệnh tiếp theo (kể cả BLOCKED); hết trận thì cho dừng; giới hạn vòng lặp; guard chặn 16 lệnh nguy hiểm mẫu (force push, reset --hard, sửa sổ cái, sửa kit, gọi Admin...) nhưng cho qua 12 lệnh làm việc bình thường; dữ liệu hỏng thì bỏ qua.
- `install`: cài, cài lại, gỡ mà vẫn giữ AGENTS.md và hook riêng của người dùng; `--no-hooks`; hooks.json hỏng thì không đụng vào.
- `security`: token không xuất hiện trong output và `.mtm/session.json` dùng mode `0600` trên POSIX.
- `e2e`: cả vòng lặp trận với Game Master giả lập, contract, review (ngoài scope, thiếu test), mọi chốt chặn, evidence gắn với commit, `fill`, chấm PASSED và FAILED, `park`, wave PI, RESUMING, `report`, `retro`, và trận mới trên cùng clone tự cất state cũ.

CI chạy Linux và Windows trên các dòng Node được hỗ trợ; child hidden tests ép reporter TAP để Node mới không bị chấm nhầm “ran no tests”.
