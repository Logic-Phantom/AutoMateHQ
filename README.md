# AI Automation HQ

<img src="docs/assets/icon.webp" width="96" alt="AI Automation HQ 아이콘" />

**여러 GitHub 저장소와 자동화 작업을 한곳에서 감시·운영하고, 매일 오전 7시(한국 시간) 카카오톡 ‘나와의 채팅’으로 운영 보고서를 보내는 개인용 관제 시스템.**

유튜브 쇼츠(StrangeRecords), 인스타그램 카드(FactBokAI), 반도체·청약·고정비 브리핑(CHIPLY·SubscriptionRadar·FixedCost), 블로그(TechLog), 생활형 앱 등 기존 프로젝트를 **수정하지 않고** GitHub API·Webhook·Heartbeat 계약으로 연결한다.

> 현재 상태: **Cloudflare 배포 완료** — https://automatehq.dlacoaud96.workers.dev (health·ready 정상). 스케줄러는 GitHub Actions OIDC 트리거로 동작 확인. **카카오 연결·테스트 메시지 발송 성공.** 07:00 정기 보고서 실제 수신과 GitHub 연결은 대기(아래 “남은 일”).

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

## 남은 일(본인 작업 필요)

- [x] Cloudflare D1 생성·migration·Worker 배포, 비밀 값(암호화 키·관리자 비밀번호 해시·Webhook secret) 등록
- [x] 스케줄러: 계정 Cron 5개 한도가 차 있어 GitHub Actions(`scheduler.yml`, 10분) + OIDC 인증으로 대체, 수동 실행 성공 확인
- [x] Kakao Developers 앱 “AI Automation HQ”(ID 1651324): 카카오 로그인 ON, Redirect URI(운영·로컬), `talk_message` 선택 동의, 웹 도메인 등록
- [x] 카카오 REST API 키·클라이언트 시크릿을 Cloudflare Secret에 등록(`KAKAO_REST_API_KEY`, `KAKAO_CLIENT_SECRET`)
- [x] 카카오 앱 아이콘 등록(`docs/assets/icon-256.png`, 256px PNG)
- [x] 대시보드 로그인 → 카카오 로그인 연결 → 테스트 메시지 발송 성공(2026-11-15 17:49 KST, 카카오 응답 `200 / result_code 0`)
- [ ] 다음 날 07:00~ 정기 보고서 실제 수신 확인
- [ ] GitHub Fine-grained PAT 발급 후 연동 설정에 저장, 프로젝트 등록(“기존 저장소에서 추가”)
- [ ] (선택) 저장소 Webhook — Secret은 로컬 `.secrets/github-webhook-secret.txt`
- [ ] (선택) Claude Code Routine 등록, 각 프로젝트 Heartbeat 연동(기존 저장소 수정 필요 — 별도 작업)

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
