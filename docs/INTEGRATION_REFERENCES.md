# 연동 공식 문서 확인 기록

확인일: **2026-11-15** (구현 시점에 직접 조회)

| 영역 | 문서 | 구현에 반영한 사실 |
|---|---|---|
| Claude Code Routines | https://code.claude.com/docs/en/routines | 웹(claude.ai/code/routines)에서 생성, API 트리거 토큰은 1회 표시·루틴별, CLI로 API 트리거 관리 불가, GitHub 트리거(PR/Release/Issue + 필터) |
| Routine fire API | https://platform.claude.com/docs/en/api/claude-code/routines-fire | `POST /v1/claude_code/routines/{trig_…}/fire`, Bearer `sk-ant-oat01-…`, `anthropic-version` 필수, beta 헤더 허용, body `text` ≤ 65,536자, 응답 session id/url, 비동기, 400/401/403/404/429(Retry-After), 루틴당 30회/시·계정 100회/시, idempotency 없음 |
| GitHub Workflow runs | https://docs.github.com/en/rest/actions/workflow-runs | list runs(워크플로별), get run, rerun / rerun-failed-jobs(201) |
| GitHub Webhook 검증 | https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries | raw body HMAC-SHA256, `X-Hub-Signature-256`, 상수 시간 비교 |
| 카카오톡 메시지 | https://developers.kakao.com/docs/ko/kakaotalk-message/rest-api | 나에게 보내기 `POST /v2/api/talk/memo/default/send`, form `template_object`, `talk_message`, `result_code 0` |
| 기본 템플릿 | https://developers.kakao.com/docs/ko/message-template/default | 텍스트 템플릿 text **최대 200자**, 버튼 최대 2개, 링크 도메인은 앱에 등록 필요 |
| 카카오 로그인 | https://developers.kakao.com/docs/ko/kakaologin/rest-api | authorize(response_type=code, scope, state), token(authorization_code/refresh_token, client_secret ON 시 필수), refresh_token은 만료 1개월 미만일 때만 응답 포함, logout/unlink |
| 토큰 수명 | https://developers.kakao.com/docs/ko/kakaologin/common | REST access 6시간, refresh 2개월 |
| Cron Triggers | https://developers.cloudflare.com/workers/configuration/cron-triggers/ | UTC 실행, `triggers.crons`, 로컬 테스트 `/cdn-cgi/local/scheduled` |
| Workers 한도 | https://developers.cloudflare.com/workers/platform/limits/ | Free: 100k 요청/일, CPU 10ms(HTTP·Cron), subrequest 50, **Cron 5개/계정** |
| D1 한도 | https://developers.cloudflare.com/d1/platform/limits/ | Free: DB 500MB, 호출당 쿼리 50(batch=1), Time Travel 7일 |

## 확인했지만 문서끼리 다른 부분

- **카카오 refresh token 갱신:** REST API 문서는 “만료 1개월 미만일 때만 새 값 제공”, 개요 문서는 “갱신 시 새 토큰 발급”. → 응답에 `refresh_token`이 **있을 때만** 교체하도록 구현해 두 경우 모두 안전.
- **Routine `anthropic-version`:** 예제마다 `2023-06-01`/`2026-10-21`. 문서상 2023-06-01 이후 모두 허용 → `2023-06-01` + beta 헤더 사용.

## 확인하지 못한 부분

- D1 무료 플랜 일일 읽기/쓰기 행 한도(한도 페이지에 미기재) → 운영 중 Cloudflare 대시보드로 확인
- Cloudflare Worker별 Cron 개수 별도 상한(계정 5개만 명시)
