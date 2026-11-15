# Cloudflare 배포

무료 플랜 기준(2026-11-15 공식 문서 확인): Workers 요청 100,000/일, 호출당 CPU 10ms, subrequest 50, **계정당 Cron Trigger 5개**, D1 DB 500MB·호출당 쿼리 50.
HQ는 Cron 표현식 1개만 쓰고, 동기화는 회당 3개 프로젝트로 나눠 이 한도를 지킨다.

## 1. D1 데이터베이스 만들기

```bash
npx wrangler d1 create automatehq
```

출력된 `database_id`를 `wrangler.jsonc`의 `d1_databases[0].database_id`에 넣는다.

## 2. 공개 주소 설정

`wrangler.jsonc` → `vars.PUBLIC_BASE_URL` 에 배포 주소(예: `https://automatehq.<계정 서브도메인>.workers.dev`)를 넣는다. 카카오 Redirect URI와 보고서 링크가 이 값을 쓴다.

## 3. 비밀 값 등록

각 명령은 값을 묻는다(터미널 기록에 남지 않게 붙여 넣기).

```bash
npx wrangler secret put ADMIN_PASSWORD_HASH
```

```bash
npx wrangler secret put HQ_ENCRYPTION_KEY
```

```bash
npx wrangler secret put GITHUB_WEBHOOK_SECRET
```

```bash
npx wrangler secret put KAKAO_REST_API_KEY
```

```bash
npx wrangler secret put KAKAO_CLIENT_SECRET
```

| 이름 | 만드는 법 | 필수 |
|---|---|---|
| `ADMIN_PASSWORD_HASH` | `npm run secret:password` | 필수 |
| `HQ_ENCRYPTION_KEY` | `npm run secret:keygen` | 필수 |
| `GITHUB_WEBHOOK_SECRET` | 임의의 긴 문자열(GitHub Webhook 설정과 동일) | 선택(없으면 polling만) |
| `KAKAO_REST_API_KEY` | Kakao Developers 앱 키 | 카카오 알림에 필수 |
| `KAKAO_CLIENT_SECRET` | 카카오 로그인 > 보안 | Client Secret 사용 시 |

## 4. 빌드 + migration + 배포

```bash
npm run deploy
```

(= `vite build` → `wrangler d1 migrations apply automatehq --remote` → `wrangler deploy`)

## 5. 배포 후 확인

```bash
curl -s https://<배포 주소>/api/health
```

```bash
curl -s https://<배포 주소>/api/health/ready
```

`ready`가 200이면 DB·암호화 키·관리자 비밀번호가 준비된 것이다. 이후 대시보드의 **연동 설정 > 온보딩 체크리스트**를 따라간다.

## 스케줄러: Cloudflare Cron 대신 GitHub Actions(현재 구성)

이 계정은 무료 플랜 Cron 5개를 다른 Worker가 모두 쓰고 있어 `wrangler deploy` 때 Cron 등록이 실패한다(code 10072). 그래서:

- `wrangler.jsonc`의 `triggers.crons`는 비우고 `vars.SCHEDULER_OIDC_REPOSITORY = "Logic-Phantom/AutoMateHQ"`로 외부 트리거를 켠다.
- `.github/workflows/scheduler.yml`이 10분마다 `POST /api/v1/scheduler/tick`을 호출한다.
- 인증은 GitHub OIDC 토큰(RS256, `aud=automatehq-scheduler`, 저장소·`refs/heads/main`·`scheduler.yml`·이벤트 schedule/workflow_dispatch 검증). 공유 비밀 값 없음.
- 공개 저장소라 Actions 사용 시간은 무료. 예약 실행은 지연될 수 있어 보고서는 07:00~12:00 KST 사이에 따라잡아 보낸다.
- Cron 슬롯이 생기면 `triggers.crons`를 `["*/10 * * * *"]`로 바꾸고 `SCHEDULER_OIDC_REPOSITORY`를 비운 뒤 워크플로를 끄면 된다.

## 암호화 키 교체

1. 기존 키를 `HQ_ENCRYPTION_KEY_PREVIOUS`로 등록하고 새 키를 `HQ_ENCRYPTION_KEY`로 등록한다.
2. GitHub 토큰·Routine 토큰을 다시 저장하고 Heartbeat secret을 재발급, 카카오를 다시 연결한다(새 키로 재암호화).
3. `HQ_ENCRYPTION_KEY_PREVIOUS`를 삭제한다.

```bash
npx wrangler secret delete HQ_ENCRYPTION_KEY_PREVIOUS
```
