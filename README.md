# AI Automation HQ

<img src="docs/assets/icon.webp" width="96" alt="AI Automation HQ 아이콘" />

**여러 GitHub 저장소와 자동화 작업을 한곳에서 감시·운영하고, 매일 오전 7시(한국 시간) 카카오톡 ‘나와의 채팅’으로 운영 보고서를 보내는 개인용 관제 시스템.**

유튜브 쇼츠(StrangeRecords), 인스타그램 카드(FactBokAI), 반도체·청약·고정비 브리핑(CHIPLY·SubscriptionRadar·FixedCost), 블로그(TechLog·GitHub Pages), GitHub 프로필, 포트폴리오(DevVibe) 등 기존 프로젝트를 **수정하지 않고** GitHub API·Webhook·Heartbeat 계약으로 연결한다.

> 현재 상태(2026-11-15 18:15 KST): **운영 중** — https://automatehq.dlacoaud96.workers.dev
> GitHub·카카오톡·Claude Routine 모두 `connected`. 프로젝트 9개 감시. 07:00 정기 보고서 첫 실수신은 아직 확인 전.
> 다음 작업은 바로 아래 **“다음 세션에서 이어서 하기”** 부터.

## 다음 세션에서 이어서 하기

### 0. 작업 환경: 집 macOS + 외부 Windows 병행(2026-11-16~)

코드·스크립트는 OS 공통(`scripts/*.mjs`는 `win32`일 때만 `npx.cmd` 사용, `.gitattributes`로 LF 고정). 맥에서 `npm install` 후 typecheck·lint·테스트 71개 통과 확인. 코드는 Git(push/pull)으로만 주고받는다.

운영 비밀 값(GitHub PAT·카카오 토큰·Routine 토큰 등)은 **Cloudflare Secret과 D1(암호화)에 있어서 PC 간에 옮길 필요가 없다.** 기기마다 따로 하는 것:

| 항목 | 기기마다? | 방법 |
|---|---|---|
| Wrangler 로그인 | 각자 1회 | `npx wrangler login`(브라우저 OAuth). D1 조회·배포·secret 등록에 필요 |
| GitHub CLI(선택) | 각자 1회 | `gh auth login`. Actions 수동 실행·로그·PR용 |
| `.dev.vars.demo` | 자동 생성 | `npm run dev:demo` 첫 실행 시 생성 |
| `.dev.vars`(운영 모드 로컬 실행 시만) | 각자 | `.dev.vars.example` 참고. 평소엔 필요 없음 |
| 관리자 비밀번호 | 공유(파일 X) | 암호 관리자에 보관. 대시보드 로그인용 |
| Webhook secret(선택 작업 때만) | 공유(파일 X) | 암호 관리자에 보관하거나 Webhook 등록 시 새로 생성해 재등록 |

- `.secrets/` 파일 자체를 복사할 필요는 없다. 값은 암호 관리자로 관리하고 메신저·클라우드 공유 폴더에 두지 않는다.
- secret 등록은 `npx wrangler secret put NAME` 실행 후 프롬프트에 직접 붙여 넣는다. 셸 파이프는 끝에 개행이 붙을 수 있다.
- (선택) Playwright E2E — `npx playwright install chromium`.

### 1. 먼저 확인할 것(순서대로)

1. **GitHub 예약 실행 간격** — 2026-11-16 확인: `schedule` 실행이 **10분 간격이 아니라 00:45·05:35·09:19 KST 3번뿐**(4~5시간 간격). 그래서 첫 07:00 보고서가 **09:19 KST에 지연 발송**됐다(`sent`, 1회 시도). 따라잡기 창(07:00~12:00) 안에 tick이 하나도 안 들어오는 날은 보고서가 빠진다. → Cloudflare Cron 복구(아래 대안)를 권장.

   ```bash
   curl -s "https://api.github.com/repos/Logic-Phantom/AutoMateHQ/actions/workflows/scheduler.yml/runs?per_page=10"
   ```

   `"event": "schedule"` 실행이 계속 없으면 07:00 보고서도 안 나간다. 대안: Actions 탭에서 수동 실행 / 다른 Worker의 Cloudflare Cron을 하나 정리해 `wrangler.jsonc`의 `triggers.crons`를 `["*/10 * * * *"]`로 복구(docs/DEPLOYMENT.md “스케줄러”).
2. **07:00 보고서 수신** — 카카오톡 ‘나와의 채팅’ + 아래 DB 조회로 `daily_reports` 상태가 `sent`인지.
3. **나머지 6개 프로젝트 동기화** — 스케줄러가 1회에 3개씩 동기화한다. `last_synced_at`이 채워졌는지.

```bash
npx wrangler d1 execute automatehq --remote --command "SELECT project_key, last_status, last_status_reason, last_synced_at FROM projects WHERE deleted_at IS NULL"
```

```bash
npx wrangler d1 execute automatehq --remote --command "SELECT report_date_local, status, sent_at, safe_error_message FROM daily_reports ORDER BY report_date_local DESC LIMIT 3"
```

### 2. 남은 작업(우선순위)

| # | 작업 | 메모 |
|---|---|---|
| 1 | DevVibe Heartbeat 연결 | HQ 프로젝트 상세(DevVibe)에서 Heartbeat 키 발급 → claude.ai “DevVibe 포트폴리오 매일 자동 갱신” 루틴 지침 끝에 HQ 보고 단계 추가(docs/HEARTBEAT_INTEGRATION.md). 루틴 클라우드 네트워크에서 workers.dev 호출 가능 여부 먼저 확인. **기존 루틴 수정이라 사용자 확인 후 진행** |
| 2 | Claude Routine 첫 호출 검증 | 대시보드 > 프로젝트 상세 > AI 유지보수 실행(AUDIT) → 세션 링크·결과 회신 확인. 회신이 막히면 세션에서 결과 확인 |
| 3 | StrangeRecords 오케스트레이터 루틴 | claude.ai에 매일 07:00 “StrangeRecords Daily Production Orchestrator” 루틴이 있음. Actions와 별개로 Heartbeat 보고를 붙일지 결정 |
| 4 | (선택) GitHub Webhook | 저장소별 Webhook 등록하면 10분 폴링 대신 즉시 반영. Secret은 `.secrets/github-webhook-secret.txt` |
| 5 | (선택) 게시 상태 연동 | 각 YouTube/Instagram 파이프라인에 publication 이벤트 전송(기존 저장소 수정 필요) |

### 3. 운영 정보(값 자체는 저장소에 없음)

| 항목 | 값/위치 |
|---|---|
| 대시보드 | https://automatehq.dlacoaud96.workers.dev (관리자 비밀번호: 로컬 `.secrets/admin-password.txt`, Git 제외) |
| Cloudflare | Worker `automatehq`, D1 `automatehq`(APAC, id `a00e5b07-…`), 계정 Cron 5개 한도 사용 중 |
| Cloudflare Secrets | `ADMIN_PASSWORD_HASH` `HQ_ENCRYPTION_KEY` `GITHUB_WEBHOOK_SECRET` `KAKAO_REST_API_KEY` `KAKAO_CLIENT_SECRET` |
| 스케줄러 | `.github/workflows/scheduler.yml`(10분) → `POST /api/v1/scheduler/tick`, GitHub OIDC 인증(비밀 값 없음) |
| 카카오 | Kakao Developers 앱 “AI Automation HQ” ID 1651324, 토큰 D1 암호화 저장, refresh 만료 2027-01-14(매일 발송되면 자동 연장) |
| GitHub 토큰 | Fine-grained “AI Automation HQ”, 저장소 10개, Actions RW + Metadata R, **2027-02-13 만료** |
| Claude Routine | “AI Automation HQ 읽기 전용 점검” `trig_017vutgzRs5qAiUeLkLtTMYu`, API 트리거, 저장소 10개, HQ 등록명 “데일리”(audit) |
| 프로젝트 등록 | `node scripts/seed-presets.mjs > .wrangler/presets.sql` → `npx wrangler d1 execute automatehq --remote --file .wrangler/presets.sql` (있는 key는 건너뜀) |
| 배포 | `npm run deploy` 또는 `npx vite build` → `npx wrangler deploy` |

### 4. 주의 사항

- **secret 등록은 셸 파이프로 하지 않는다**(Windows PowerShell은 CRLF, macOS `echo`는 LF가 붙어 KOE101 발생 사례). 직접 프롬프트에 붙여 넣거나 Node `spawnSync(..., { input: value.trim() })`.
- 기존 프로젝트 저장소와 기존 claude.ai 루틴은 사용자 확인 없이 수정하지 않는다.
- 토큰·시크릿 값은 채팅·로그·README에 남기지 않는다. 브라우저에서 생성된 토큰은 사용자가 직접 복사해 HQ에 입력한다.

## 주요 기능

| 영역 | 내용 |
|---|---|
| 관제 대시보드 | 상태 분포 막대, 24시간 실행/실패 + 14일 스파크라인, 14일 실행 결과 누적 막대, 프로젝트별 14일 실행 스트립, 미해결 장애, 실행 타임라인, 다음 예정 작업, 오늘 07:00 보고서 상태 |
| 프로젝트 관리 | 등록·수정·비활성·soft delete, 기존 저장소 등록 제안, 기대 일정(매일·평일·요일·N시간·비정기)·유예 시간·중요도, 연결 테스트(워크플로 비활성/삭제 감지), Heartbeat 키 발급·재발급·폐기, 유지보수 허용 범위 |
| GitHub | Fine-grained PAT(암호화 저장), Actions 실행 폴링, `workflow_run` Webhook(HMAC·중복 차단), 401/403/404/rate limit 분류, **승인 기반 실패 job 재실행**(확인 문구·idempotency·직전 상태 재확인) |
| Heartbeat | `start/complete/fail/events` 서명 API(HMAC + timestamp + nonce), Node·Python 예제 |
| 게시 추적 | YouTube/Instagram 단계(planned→published/failed), 파이프라인 성공과 게시 완료 분리, “게시 완료 보고됨” vs “공식 API 검증” 구분 |
| 판정·장애 | NORMAL/FAILED/ATTENTION/UNKNOWN, 예정일·유예·기준선 반영 미실행 탐지, 수집 실패 구분, fingerprint 묶음·자동 복구, 즉시 알림 쿨다운 |
| 카카오톡 | OAuth(state), 토큰 암호화·자동 갱신·회전, 재연결 필요 감지, 테스트 메시지, **07:00 KST 정기 보고서**(날짜별 1회, 지연 복구, 3회 재시도), 장애 즉시 알림 |
| AI 유지보수 | Claude Code Routine fire 어댑터(공식 계약), AUDIT/PROPOSE/DRAFT_PR 정책, 결과 회신(작업별 토큰), 테스트 미통과 PR은 “검토 필요”, 미연결 시 규칙 기반 점검 |
| 비용·사용량 | GitHub Actions 실행 시간 막대 차트, ACTUAL/ESTIMATED/MANUAL/UNAVAILABLE 구분, 수동 기록 |
| 보안 | 관리자 로그인(PBKDF2)·세션 쿠키·CSRF·호출 제한·AES-GCM·마스킹·감사 로그·보안 헤더 |

## 기술 스택

React 19 · TypeScript(strict) · Vite 8 · Tailwind CSS 4 · TanStack Query · React Router · Recharts · Pretendard
Cloudflare Workers · Hono · D1(SQLite) · Cron Triggers · Static Assets · Zod
Vitest · React Testing Library · Playwright · ESLint · Prettier · Wrangler

```text
src/            React 대시보드 (pages, components, charts)
worker/src/     Worker API: routes · services(github, heartbeat, kakao, claude, monitoring, incidents, reporting, publications, maintenance, usage) · security · scheduler
worker/migrations/  D1 스키마
shared/         공용 상수 · Zod 스키마 · 프로젝트 등록 제안
tests/          unit · integration(실제 migration + Node SQLite) · e2e(Playwright)
docs/           설계·설정·배포·운영 문서
scripts/        로컬 실행 · 샘플 데이터 · 비밀 값 생성 · Heartbeat CLI
```

## 빠른 시작(샘플 모드)

```bash
npm install
```

```bash
npm run dev:demo
```

http://localhost:5173 · 비밀번호 `demo` · 외부 API 호출 없음 · 운영 DB와 분리된 로컬 D1 사용

## 명령어

| 명령 | 설명 |
|---|---|
| `npm run dev:demo` | 샘플 모드(로컬 전용) |
| `npm run dev` | 운영 모드 로컬 실행(.dev.vars 필요) |
| `npm test` | 단위·통합·컴포넌트 테스트 |
| `npm run test:e2e` | Playwright E2E |
| `npm run typecheck` / `npm run lint` | 타입·린트 |
| `npm run secret:password` / `npm run secret:keygen` | 관리자 비밀번호 해시 / 암호화 키 생성 |
| `npm run deploy` | 빌드 → D1 migration(원격) → Worker 배포 |

## 문서

- [아키텍처](docs/ARCHITECTURE.md) · [로컬 실행](docs/SETUP.md) · [배포](docs/DEPLOYMENT.md) · [보안](docs/SECURITY.md) · [운영 Runbook](docs/RUNBOOK.md)
- [카카오 설정](docs/KAKAO_SETUP.md) · [GitHub 설정](docs/GITHUB_SETUP.md) · [Claude Routines](docs/CLAUDE_ROUTINES_SETUP.md) · [Heartbeat 연동](docs/HEARTBEAT_INTEGRATION.md)
- [공식 문서 확인 기록](docs/INTEGRATION_REFERENCES.md)

## 기획서(슈퍼프롬프트) 검토 후 바꾼 점

| 기획서 | 문제 | 반영 |
|---|---|---|
| 07:00 보고서를 한 통의 긴 카카오 메시지로 | 기본 텍스트 템플릿 **text 최대 200자**(공식 문서) | 요약·상세·분석 최대 3통(각 ≤200자) + “HQ에서 보기” 버튼 → 전체 보고서 페이지 |
| Cron `0 22 * * *` 단일 실행 | Cron 지연·누락 시 그날 보고서가 사라짐, 무료 계정 Cron 5개 제한 | 표현식 1개 `*/10 * * * *`로 07:00~12:00 KST 사이 미발송분 따라잡기 + 날짜 UNIQUE로 중복 방지(기존 브리핑의 07:07+백업 cron 교훈) |
| 관리자 비밀번호를 Secret에 보관 | 평문 비밀번호가 Secret에 있음 | PBKDF2 해시만 Secret에 보관(`npm run secret:password`) |
| 카카오 연결 해제 | 같은 카카오 앱을 쓰는 기존 브리핑 프로젝트까지 unlink로 끊길 위험 | unlink 미사용. 로컬 삭제 또는 logout(이 토큰만). HQ 전용 앱 권장 |
| refresh token 응답마다 교체 | 공식 문서: 만료 1개월 미만일 때만 새 값 포함 | 응답에 있을 때만 교체, 만료 예정일 표시 |
| Routine 결과 상태 추적 | fire API는 세션 생성까지만 응답, 상태 조회 API 없음 | ‘시작됨’까지만 기록 + 작업별 1회용 토큰으로 결과 회신 API + 수동 승인/반려 |
| Routine 중복 방지 | API에 idempotency key 없음 | HQ에서 같은 작업 1시간 내 중복 차단 + 시간당 10회 제한 |
| 미실행 판정 | 기존 브리핑은 실패 시 수동 재실행(workflow_dispatch)·백업 cron | 예정 시각 60분 전~이후 시작한 모든 실행을 같은 회차로 인정, 유예 120~150분 제안 |
| Mock 모드 | 같은 DB에 섞일 위험 | 별도 D1 DB(`automatehq-demo`) + `[샘플]` 표기 + 외부 호출 차단 + 원격 시드 거부 |
| 게시 상태 | Actions 성공 = 게시 성공으로 오해 | run과 publication 분리, 확인 출처(보고/검증) 표시 |
| Webhook 서명 실패 기록 | 공격자가 delivery ID를 선점해 정상 이벤트를 “중복” 처리시킬 수 있음 | 서명 실패는 별도 provider 키로 기록 |
| 디자인 | – | taste-skill 원칙 중 대시보드에 맞는 것(따뜻한 near-black·단일 파랑 강조·sharp 반경·헤어라인·절제된 모션·보라 금지)과 dataviz 검증 팔레트 적용 |

## 테스트 결과(2026-11-15 로컬)

- `npm run typecheck` 통과 · `npm run lint` 통과
- `npm test`: **71개 통과**(판정 14 · GitHub 9 · Heartbeat 7 · 카카오 10 · 유지보수 9 · 보안 13 · 스케줄러 OIDC 4 · 컴포넌트 5)
- `npm run test:e2e`: **3개 통과**(로그인·대시보드 차트, 재실행 확인 모달, 카카오 보고서 미리보기 200자)
- `vite build` 성공, `wrangler deploy --dry-run` 번들 성공(gzip 약 184 KiB)

## 진행 체크리스트

- [x] Cloudflare D1 생성·migration·Worker 배포, 비밀 값(암호화 키·관리자 비밀번호 해시·Webhook secret) 등록
- [x] 스케줄러: 계정 Cron 5개 한도가 차 있어 GitHub Actions(`scheduler.yml`, 10분) + OIDC 인증으로 대체, 수동 실행 성공 확인
- [x] Kakao Developers 앱 “AI Automation HQ”(ID 1651324): 카카오 로그인 ON, Redirect URI(운영·로컬), `talk_message` 선택 동의, 웹 도메인 등록
- [x] 카카오 REST API 키·클라이언트 시크릿을 Cloudflare Secret에 등록(`KAKAO_REST_API_KEY`, `KAKAO_CLIENT_SECRET`)
- [x] 카카오 앱 아이콘 등록(`docs/assets/icon-256.png`, 256px PNG)
- [x] 대시보드 로그인 → 카카오 로그인 연결 → 테스트 메시지 발송 성공(2026-11-15 17:49 KST, 카카오 응답 `200 / result_code 0`)
- [x] 첫 정기 보고서 발송(2026-11-16 09:19 KST, 스케줄러 지연으로 2시간 19분 늦음)
- [x] GitHub Fine-grained PAT 발급(“AI Automation HQ”, 저장소 8개, Actions 읽기·쓰기 + Metadata 읽기, 2027-02-13 만료) 후 연동 설정에 저장 — Logic-Phantom으로 연결됨
- [x] 프로젝트 등록(`scripts/seed-presets.mjs` → D1, 대시보드 “기존 저장소에서 추가”와 같은 값): StrangeRecords·FactBokAI·CHIPLY·청약·고정비·TechLog·GitHub 프로필·기술 블로그(Pages)·DevVibe. 점심합의는 감시 제외(이력 보관)
- [x] GitHub 토큰 저장소 범위 갱신(점심합의 제외, Logic-Phantom·Logic-Phantom.github.io·DevVibe 추가 → 10개)
- [x] Claude Code Routine “AI Automation HQ 읽기 전용 점검” 생성(API 트리거, 감시 저장소 10개)
- [x] Routine Fire URL·토큰을 HQ 연동 설정 > Claude Code Routines에 등록(용도 audit, 표시 이름 “데일리”) — `connected`
- [x] GitHub `schedule` 예약 실행 시작 확인(2026-11-16 00:45·05:35·09:19 KST) — 단, 간격이 4~5시간이라 Cloudflare Cron 복구 검토 필요
- [ ] 정기 보고서 정시(07:00대) 발송 — 스케줄러 지연 해결 필요
- [x] 맥 환경: `npx wrangler login` 완료(관리자 비밀번호는 암호 관리자로 공유)
- [x] 감시 프로젝트 8개 동기화 완료(DevVibe는 Heartbeat 대상이라 제외)
- [ ] DevVibe: 매일 09:00 루틴이 HQ에 Heartbeat를 보내도록 연결. 연결 전까지 ‘확인 불가’
- [ ] Claude Routine 첫 AUDIT 호출·결과 회신 검증 — 2026-11-16 첫 호출이 ‘네트워크’ 실패: Workers fetch가 `redirect: 'error'`를 지원하지 않아 호출 전 TypeError. `manual`+3xx 거부로 수정·배포 → 12:26 재호출 **세션 생성 성공**. 결과 회신(callback) 도착 확인 남음
- [ ] (선택) 저장소 Webhook — Secret은 로컬 `.secrets/github-webhook-secret.txt`
- [ ] (선택) 각 YouTube/Instagram 파이프라인 게시 이벤트 연동(기존 저장소 수정 필요 — 별도 작업)

## 작업 내역

### 2026-11-15
- 기획서 검토, 기존 프로젝트(CHIPLY·StrangeRecords·FactBokAI·SubscriptionRadar·FixedCost·TechLog 등) 구조·cron·카카오 발송 방식 조사
- Claude Code Routines·GitHub·Kakao·Cloudflare 공식 문서 확인 → `docs/INTEGRATION_REFERENCES.md`
- Worker API(Hono)·D1 스키마·보안 계층·GitHub/Heartbeat/카카오/Routine 어댑터·판정 엔진·장애 엔진·07:00 보고서·스케줄러 구현
- React 대시보드 10개 화면 + 로그인, 샘플 모드(별도 D1, 14일 샘플 데이터)
- taste-skill·dataviz 기준 디자인 정리, Recharts 차트(14일 누적 막대·스파크라인·상태 분포·실행 스트립·소요 시간 선·실행 시간 막대) 추가
- 테스트 67개 + E2E 3개, CI 워크플로, 문서 10종
- Cloudflare 배포(workers.dev, D1 APAC)·비밀 값 등록. 계정 Cron 한도 초과로 GitHub Actions OIDC 스케줄러(`/api/v1/scheduler/tick`) 추가·실행 검증(테스트 71개)
- 크롬에서 Kakao Developers 전용 앱 생성, 카카오 로그인·Redirect URI·talk_message·웹 도메인 설정, 앱 아이콘 등록
- 카카오 REST API 키·클라이언트 시크릿 Cloudflare Secret 등록
- KOE101 해결: PowerShell 파이프로 등록한 secret 끝의 CRLF 제거(재등록 + 코드에서 trim) → 카카오 연결·테스트 메시지 성공
- 크롬에서 GitHub Fine-grained 토큰 생성(최소 저장소·권한), HQ 연결 확인, 기존 자동화 프로젝트 7개 등록
- 점심합의 감시 제외, GitHub 프로필·기술 블로그·DevVibe 추가(DevVibe는 Anthropic 클라우드 루틴 → Heartbeat 감시), 토큰 저장소 범위 갱신
- claude.ai에 HQ용 읽기 전용 점검 Routine(API 트리거, 저장소 10개) 생성 → 사용자가 HQ에 등록, `connected` 확인
- 마감 시점 상태: 연동 3종 connected, 프로젝트 9개(동기화 완료 3·대기 6), 수집된 실행 45건, 카카오 테스트 메시지 1건 발송. GitHub 예약 실행은 아직 시작 전(수동 2회)

### 2026-11-16
- 맥(집)·윈도우(외부) 병행 환경 구성: 맥에서 `npm install`, typecheck·lint·테스트 71개 통과(코드 변경 없음). Wrangler 로그인은 사용자 작업으로 남김
- 맥에서 Wrangler 로그인 완료
- GitHub `schedule` 실행 확인: 00:45·05:35·09:19 KST(4~5시간 간격) → 첫 정기 보고서 09:19 KST 지연 발송(`sent`). Cloudflare Cron 복구 검토
- 동기화 8개 완료. 기술 블로그(Logic-Phantom.github.io) 2026-11-16 03:02 KST `pages build and deployment` 실패 — build 성공, Deploy to GitHub Pages 단계만 실패(사이트는 200 응답). 일시 오류로 보이며 다음 실행 또는 HQ 재실행으로 확인
- Claude Routine 첫 AUDIT(기술 블로그) 실패 원인 확인: `routine.ts`의 `redirect: 'error'`가 Workers 런타임에서 TypeError(로컬 workerd로 재현). `redirect: 'manual'` + 3xx 거부 + 시간 초과 구분으로 수정, 테스트 1개 추가(72개 통과)
- 수정본 운영 배포(버전 `31fcd183`) → AUDIT 재실행 시 Routine 세션 생성 성공(`시작됨`)
