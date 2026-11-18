# GitHub 연결

## 1. Fine-grained Personal Access Token

GitHub → Settings → Developer settings → Fine-grained tokens → Generate new token

- Resource owner: `Logic-Phantom`
- Repository access: **Only select repositories** → 감시할 저장소만
- 만료: 90일 권장(만료 전 재발급)

| 기능 | 권한(Repository permissions) |
|---|---|
| 조회(필수) | Metadata: Read · Actions: Read |
| 코드 분석(선택) | Contents: Read · Pull requests: Read |
| 실패 워크플로 재실행 | **Actions: Read and write** |
| (HQ 자체는 PR을 만들지 않음) | Draft PR은 Claude Code Routine이 Claude GitHub App 권한으로 만든다 |

사용 엔드포인트: `GET /repos/{o}/{r}`, `GET …/actions/workflows`, `GET …/actions/workflows/{file}/runs`, `GET …/actions/runs/{id}`, `POST …/actions/runs/{id}/rerun-failed-jobs`, `GET /rate_limit`, `GET /user`.

대시보드 **연동 설정 > GitHub**에 토큰을 저장하면 `/user`·`/rate_limit`으로 검증한 뒤 암호화 저장한다. 오류는 401(인증)·403(권한)·rate limit·404·5xx로 나눠 표시한다.

## 2. 프로젝트 등록

**프로젝트 > 기존 저장소에서 추가**에 기존 자동화 저장소(StrangeRecords, FactBokAI, CHIPLY, SubscriptionRadar, FixedCost, TechLog, JARVIS 등)의 워크플로·cron을 참고한 등록 제안이 있다. 선택 후 확인해야 저장된다. 등록 후 상세 화면의 **연결 테스트**로 저장소 접근·워크플로 활성 상태·최근 실행 수집을 확인한다.

기존 브리핑 프로젝트는 07:07 + 백업(07:37/08:07/09:07) cron을 쓰므로 유예 시간을 120~150분으로 잡았다.

### Actions가 없는 자동화: 저장소 커밋 감시

claude.ai 루틴처럼 GitHub Actions 없이 **저장소에 커밋을 남기는** 자동화는 모니터링 방식을 **저장소 커밋 감시**(`github_commits`)로 둔다.

- 기본 브랜치에서 **실행으로 인정할 커밋 문구**(예: `[자동 갱신]`)가 들어간 커밋 1건 = 성공 실행 1회. 비우면 모든 커밋.
- 실패는 커밋으로 드러나지 않으므로 **예정 시각 + 유예 시간 안에 커밋이 없으면 ‘미실행’**으로 잡는다.
- 자동화 쪽 수정·Heartbeat secret이 필요 없다. 같은 GitHub 토큰으로 `GET /repos/{owner}/{repo}/commits`만 호출한다(최근 14일, 최대 50건).
- 예: DevVibe(매일 09:00 루틴, 유예 120분) — 루틴 클라우드 세션은 외부 API 호출이 막혀 Heartbeat를 보낼 수 없어 이 방식을 쓴다.
- 주의: 변경할 내용이 없어 루틴이 커밋을 남기지 않는 날은 ‘미실행’으로 보인다. 그런 날이 잦으면 루틴이 빈 커밋이라도 남기게 하거나 주기를 `비정기`로 바꾼다.

## 3. Webhook(선택, 즉시 반영)

없어도 10분 polling으로 동작한다. 저장소마다:

Settings → Webhooks → Add webhook

- Payload URL: `{PUBLIC_BASE_URL}/api/webhooks/github`
- Content type: `application/json`
- Secret: `GITHUB_WEBHOOK_SECRET`과 같은 값
- Events: **Let me select individual events → Workflow runs**

저장하면 GitHub가 ping을 보낸다. 연동 설정 화면의 “Webhook 최근 수신”에서 `processed`를 확인한다. 서명이 틀리면 `rejected`로 기록되고 처리하지 않는다.

## 4. 토큰 회전

새 토큰 발급 → HQ에 저장 → GitHub에서 이전 토큰 삭제. 토큰이 만료되면 HQ가 `재연결 필요`와 전역 incident를 띄운다.
