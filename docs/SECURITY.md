# 보안 설계

| 영역 | 구현 |
|---|---|
| 관리자 인증 | 비밀번호는 PBKDF2-SHA256(100,000회, Workers 상한) 해시만 Cloudflare Secret에 둔다. D1에 평문 없음 |
| 세션 | 32바이트 랜덤 토큰, DB에는 SHA-256만. 쿠키 `HttpOnly; Secure; SameSite=Strict`, 12시간 만료, 로그아웃 시 삭제 |
| CSRF | 상태 변경 요청은 세션별 `X-CSRF-Token` + Origin 허용 목록 검사 |
| 로그인 제한 | IP 해시 기준 15분 5회 |
| 비밀 값 저장 | GitHub 토큰·카카오 토큰·Routine 토큰·Heartbeat secret은 AES-256-GCM(+용도별 AAD)으로 암호화해 D1에 저장. 키는 Secret |
| 응답 노출 | 연동 정보는 존재 여부·힌트(앞 몇 글자)만 반환. Heartbeat secret은 발급 응답에서 1회만 표시 |
| 로그 마스킹 | `redact()`가 Bearer·access_token·refresh_token·client_secret·ghp_/github_pat_/sk-ant- 패턴을 가림 |
| GitHub Webhook | raw body 기준 `X-Hub-Signature-256` HMAC 상수 시간 비교, `X-GitHub-Delivery` 중복 차단, 허용 이벤트만, payload 원문 미저장, IP당 분당 300회 |
| Heartbeat | `HMAC(secret, "{timestamp}.{rawBody}")`, ±5분, (project, runId, type, ts, sig) nonce 재전송 차단, 분당 120회, 프로젝트 존재 여부 비노출 |
| 카카오 OAuth | 1회용 state(쿠키 + DB 해시, 10분), 토큰 교환·갱신은 서버에서만, Client Secret 포함 |
| SSRF | 외부 호출 대상 고정(GitHub API, Kakao, `api.anthropic.com/v1/claude_code/routines/trig_…/fire` 정규식). 임의 URL fetch 없음 |
| 입력 검증 | 모든 본문 Zod 검증, prepared statement만 사용 |
| 헤더 | API: CSP `default-src 'none'`·nosniff·DENY·HSTS·no-store. 정적 자산: `public/_headers` CSP |
| 감사 로그 | 로그인·프로젝트 CRUD·재실행·연동 연결/해제·secret 재발급·유지보수·설정 변경·내보내기 |
| 재실행 | 확인 문구 `RERUN` + idempotency key + 직전 GitHub 상태 재확인(실행 중/성공 거부) + 5분 내 중복 거부 |
| 유지보수 | 기본 AUDIT, DRAFT_PR은 프로젝트별 명시 허용. HQ는 merge·push 하지 않음. 결과 회신은 작업별 1회용 토큰 |

## 하지 않는 것

- 비공식 엔드포인트·스크래핑·쿠키 복제로 게시 상태 확인
- 카카오 친구 발송, 읽음 여부 추정
- API가 주지 않는 비용·조회수 추정치를 실제값처럼 표시

## 토큰 재발급·연동 해제

- GitHub: 새 PAT 발급 → 연동 설정에서 저장(이전 토큰은 GitHub에서 폐기)
- 카카오: 알림 > 연결 해제(HQ 삭제 또는 로그아웃 API로 이 토큰만 폐기) → 다시 연결
- Routine: claude.ai에서 토큰 재생성(이전 토큰 즉시 무효) → HQ에서 삭제 후 재등록
- Heartbeat: 프로젝트 상세 > 재발급(이전 secret 즉시 거부)
