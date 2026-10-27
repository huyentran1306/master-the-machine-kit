# Kit3: phục hồi đăng nhập và đồng bộ đề

## Vấn đề

Portal có thể trả HTTP 200 cùng HTML `Loading match…` khi client chưa có dữ liệu hoặc phiên đăng nhập không được chấp nhận. Phiên bản cũ coi response đó là login thành công rồi báo `BACKLOG_SYNC COMPLETED` với 0 item. Agent tiếp tục chờ dù chưa biết trạng thái trận hay UUID dùng cho Start Work/Submit.

Một lượt chạy v1 trước đây đã phục hồi nhờ agent sửa bridge tạm thời trong bộ nhớ: thêm `Origin`/`Referer` vào JSON login. Phần sửa tạm ấy không có trong runtime cài đặt của lượt kế tiếp. Kit3 đưa cách xử lý vào code và test, để không phụ thuộc agent tự đoán lại.

## Luồng mới

1. Gửi login qua các strategy được cấu hình, với header POST cùng origin như trình duyệt. Không thay cơ chế xác thực hay bỏ qua kiểm tra CSRF của server.
2. Xác minh tài liệu match thực tế, thay vì chỉ nhìn HTTP status.
3. Nếu HTML chưa có dữ liệu, gọi các đường dẫn contestant JSON đã cấu hình. Mặc định `/api/v1/match/{matchId}` là route được client public của portal sử dụng. Không dò endpoint admin hoặc endpoint riêng của Player.
4. Dùng cùng cookie jar, origin allowlist, request logger và parser cho login và refresh. HTTP 401/403 của JSON view kích hoạt re-login có giới hạn.
5. Preparation chỉ hoàn thành khi metadata xác thực đọc được và các bước môi trường đã hoàn tất. Không đòi backlog hay UUID trước khi server công bố chúng.
6. Trong GAME, UUID phải đọc được. Nếu không, sync báo FAILED với hướng phục hồi; không trình bày loading shell như backlog trống đã đồng bộ thành công.

## Cải tiến khác kế thừa từ Kit2

- Checklist lấy acceptance criteria và MVS của đúng item.
- Theo dõi các vòng test thất bại để nhắc đổi cách tiếp cận hoặc chuyển việc.
- Submission kiểm tra BACKLOG_TESTS và nội dung evidence. Trường hợp thực sự không có test có thể dùng escape hatch `allowUntested`, với cảnh báo rõ ràng.

## Các test có thể chạy từ repo

```sh
node --test tests/portal-recovery.test.mjs
```

- Form POST trả loading shell không được coi là đăng nhập thành công; JSON login có đúng Origin/Referer phải lấy được dữ liệu.
- Đăng nhập được nhưng JSON vẫn chỉ loading thì verification thất bại.
- Sau Start, JSON view cung cấp đúng UUID và backlog.
- Loading không được đánh dấu BACKLOG_SYNC complete hoặc phát readiness.
- Cookie bị từ chối thì refresh re-login có giới hạn và phục hồi.
- Preparation hợp lệ trước khi có UUID; sau Start lấy UUID và làm việc bình thường.

Test chỉ dùng dữ liệu giả, không cần credential thật. Khi đổi portal hoặc domain cho vòng chính, kiểm tra lại login và dữ liệu trước Start; một trận kết thúc không thể được reset chỉ bằng Initialize local.
