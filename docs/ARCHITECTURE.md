# 아키텍처

## 구성

```text
사용자(브라우저 / 카카오톡 나와의 채팅)
        │ HTTPS
┌───────▼─────────────────────────────────────────────┐
│ Cloudflare Worker  (automatehq)                      │
│  ├─ Static Assets: React 대시보드(dist/client, SPA)  │
│  ├─ Hono REST API  /api/*                            │
│  │   ├─ 공개(서명 검증): /api/webhooks/github,        │
│  │   │   /api/v1/heartbeat/*, /api/v1/events,        │
│  │   │   /api/v1/maintenance/callback, 카카오 콜백   │
│  │   └─ 관리자(세션+CSRF): 나머지 전부               │
│  └─ scheduled(): Cron "*/10 * * * *" (UTC)           │
│       ├─ GitHub Actions 폴링(회당 3개 프로젝트)       │
│       ├─ 전 프로젝트 판정 + incident 열기/닫기        │
│       ├─ 12:00~22:00 KST 미발송 일일 보고서 발송      │
│       └─ 장애 즉시 알림(쿨다운)·정리 작업             │
└───────┬───────────────┬───────────────┬─────────────┘
        │               │               │
   D1 (SQLite)     GitHub REST     Kakao OAuth/메시지 · Claude Routine fire
```

- **기존 프로젝트는 건드리지 않는다.** HQ는 GitHub API·Webhook·Heartbeat 계약으로만 연결한다.
- 무거운 작업(영상 인코딩, AI 추론)은 HQ Worker에서 하지 않는다.

## 디렉터리

| 경로 | 책임 |
|---|---|
| `src/` | React 대시보드(화면·차트). `@shared` 별칭으로 공용 상수·스키마 사용 |
| `worker/src/routes` | HTTP 경계(입력 검증·인증·응답 형식) |
| `worker/src/services/*` | 도메인 로직: github, heartbeat, kakao, claude, monitoring, incidents, reporting, publications, maintenance, usage |
| `worker/src/repositories` | D1 접근(감사 로그·설정·잠금·호출 제한·연동·프로젝트) |
| `worker/src/security` | AES-GCM·HMAC·PBKDF2·세션/CSRF·마스킹 |
| `worker/src/scheduler` | Cron 한 번에 하는 작업 묶음 |
| `worker/migrations` | D1 스키마 |
| `shared/` | 상수·Zod 스키마·프로젝트 등록 제안(presets) |
| `tests/` | unit / integration(실제 migration을 Node SQLite에 적용) / e2e(Playwright) |

## 상태 판정(monitoring/classifier.ts)

순수 함수. 입력은 프로젝트 일정(주기·시각·시간대·유예), 최근 run, 게시 기록, 연동 상태, 수집 오류, 외부 incident.

| 결과 | 조건(우선순위 순) |
|---|---|
| FAILED | 최근 완료 run 실패 · 최근 게시 실패 · high 이상 외부 incident |
| ATTENTION | 예정+유예 경과 후 실행 없음(MISSED_RUN) · 3시간 넘게 실행 중 · 수집 실패 · 연동 오류 · 게시 확인 대기 |
| UNKNOWN | 소스 미연결 · GitHub 토큰 없음 · 데이터 없음 · 등록 후 24시간 기준선 |
| NORMAL | 위에 해당 없고 최근 성공 기록 있음 |

- 예정일이 아닌 날(평일 일정의 주말 등)은 미실행으로 보지 않는다.
- 예정 시각 60분 전부터 시작한 실행도 그 회차로 인정한다(수동 재실행 포함).
- 집계는 활성 프로젝트만, 프로젝트당 1회만 센다. UNKNOWN은 NORMAL에 넣지 않는다.

## Incident

- fingerprint `project:{id}:{사유}`로 묶고, 미해결 incident는 fingerprint당 하나(부분 unique index).
- 판정 사유가 사라지면 자동 해결(복구). 인증 오류·서명 불일치 같은 이벤트성 incident는 별도 fingerprint(`integration:github:AUTH_INVALID` 등).
- 즉시 알림: 새 high 이상·심각도 상승·복구만, fingerprint별 쿨다운(기본 3시간), 여러 건을 한 메시지로 묶음.

## 12:00 KST 보고서

감시 대상 자동화가 대부분 07:00~12:00 사이에 끝나므로 12:00에 보낸다(2026-11-16 07:00 → 12:00 변경). 시각은 `shared/constants`의 `DAILY_REPORT_HOUR`·`DAILY_REPORT_CATCHUP_END_HOUR` 두 값으로만 정한다.

1. Cron(10분 간격, UTC) → Asia/Seoul 시각 계산
2. 12:00 ≤ 현지 시각 < 22:00 이고 `daily_reports.report_date_local`에 sent 없음 → 진행(지연 복구)
3. 잠금(`job_locks`) → 판정 → 보고서 JSON → 카카오 메시지(각 200자 이하, 최대 3개)
4. 토큰 갱신(필요 시) → 나에게 보내기 → 결과를 `daily_reports`·`notification_deliveries`에 기록
5. 실패 시 다음 Cron에서 재시도(최대 3회). 재인증 필요·미설정은 즉시 종료 상태로 남김.

## Mock(샘플) 모드 분리

- `wrangler dev --env demo` 는 **별도 D1 데이터베이스(`automatehq-demo`)** 를 쓴다. 운영 DB와 물리적으로 분리.
- 샘플 데이터는 `scripts/demo-reset.mjs`가 로컬 demo DB에만 넣고, 모든 이름에 `[샘플]`을 붙인다. `--remote`는 거부.
- 샘플 모드에서는 GitHub·카카오·Routine 등 외부 호출을 하지 않고, 화면 상단에 “샘플 데이터” 배너가 항상 보인다.
