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

**프로젝트 > 기존 저장소에서 추가**에 기존 자동화 저장소(StrangeRecords, FactBokAI, CHIPLY, SubscriptionRadar, FixedCost, TechLog, lunchagree)의 워크플로·cron을 참고한 등록 제안이 있다. 선택 후 확인해야 저장된다. 등록 후 상세 화면의 **연결 테스트**로 저장소 접근·워크플로 활성 상태·최근 실행 수집을 확인한다.

기존 브리핑 프로젝트는 07:07 + 백업(07:37/08:07/09:07) cron을 쓰므로 유예 시간을 120~150분으로 잡았다.

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
