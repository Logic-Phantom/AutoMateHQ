# Heartbeat 연동

GitHub Actions가 아닌 자동화(로컬 PC·서버·다른 클라우드)나, Actions 안에서 **게시 단계**를 따로 보고하고 싶을 때 쓴다.

## 엔드포인트

| 경로 | 의미 | run 상태 |
|---|---|---|
| `POST /api/v1/heartbeat/start` | 실행 시작 | running |
| `POST /api/v1/heartbeat/complete` | 정상 종료 | success(본문 status=skipped면 skipped) |
| `POST /api/v1/heartbeat/fail` | 실패 | failure |
| `POST /api/v1/events` · `POST /api/publications/events` | 단계/게시 이벤트 | 본문 status |

## 서명

```
X-HQ-Project:   <projectKey>
X-HQ-Timestamp: <unix 초>
X-HQ-Signature: sha256=<hex(HMAC_SHA256(secret, "<timestamp>.<raw body>"))>
```

- secret: 프로젝트 상세 → Heartbeat 키 발급(1회만 표시) → 자동화 쪽 비밀 저장소(`HQ_HEARTBEAT_SECRET`)
- 시각 오차 ±5분, 같은 요청 재전송은 중복 처리(`duplicate: true`)
- 응답: `{ ok, data: { eventId, duplicate } }`. secret은 절대 돌려주지 않는다.

## 본문

```json
{
  "projectKey": "instagram-card-publisher",
  "source": "instagram-pipeline",
  "runId": "2026-11-16-abc123",
  "stage": "published",
  "startedAt": "2026-11-15T22:00:00Z",
  "completedAt": "2026-11-15T22:03:15Z",
  "externalUrl": "https://github.com/…/actions/runs/1",
  "metrics": { "generatedItems": 1, "publishedItems": 1 },
  "message": "카드 콘텐츠 생성 및 게시 완료",
  "publication": {
    "platform": "instagram",
    "contentKey": "card-2026-11-16",
    "title": "오늘의 카드",
    "status": "published",
    "platformPostId": "1789…",
    "platformUrl": "https://www.instagram.com/p/…/"
  }
}
```

- `externalUrl`·`platformUrl`은 https만, 실제 플랫폼이 준 URL만 넣는다.
- publication.status: `planned` `generating` `generated` `uploading` `published` `failed` `verification_pending`
- heartbeat로 보고된 게시는 “게시 완료 보고됨”으로 표시된다(공식 API 검증과 구분).

## Node.js 예제

```js
import { createHmac } from 'node:crypto';

export async function heartbeat(type, payload) {
  const body = JSON.stringify({ projectKey: process.env.HQ_PROJECT_KEY, ...payload });
  const ts = Math.floor(Date.now() / 1000);
  const sig = 'sha256=' + createHmac('sha256', process.env.HQ_HEARTBEAT_SECRET).update(`${ts}.${body}`).digest('hex');
  try {
    const res = await fetch(`${process.env.HQ_URL}/api/v1/heartbeat/${type}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-HQ-Project': process.env.HQ_PROJECT_KEY, 'X-HQ-Timestamp': String(ts), 'X-HQ-Signature': sig },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) console.warn('HQ heartbeat 실패', res.status);
  } catch (e) {
    console.warn('HQ heartbeat 전송 실패(본 작업은 계속)', e.message);
  }
}

// await heartbeat('start', { runId, stage: 'generating' });
// await heartbeat('complete', { runId, stage: 'published', publication: { platform: 'youtube', contentKey, status: 'published', platformUrl } });
```

## Python 예제

```python
import hashlib, hmac, json, os, time, urllib.request

def heartbeat(kind: str, payload: dict) -> None:
    body = json.dumps({"projectKey": os.environ["HQ_PROJECT_KEY"], **payload}, ensure_ascii=False, separators=(",", ":"))
    ts = str(int(time.time()))
    sig = "sha256=" + hmac.new(os.environ["HQ_HEARTBEAT_SECRET"].encode(), f"{ts}.{body}".encode(), hashlib.sha256).hexdigest()
    req = urllib.request.Request(
        f"{os.environ['HQ_URL']}/api/v1/heartbeat/{kind}",
        data=body.encode(),
        method="POST",
        headers={"Content-Type": "application/json", "X-HQ-Project": os.environ["HQ_PROJECT_KEY"], "X-HQ-Timestamp": ts, "X-HQ-Signature": sig},
    )
    try:
        urllib.request.urlopen(req, timeout=10)
    except Exception as exc:  # HQ 장애가 본 작업을 막지 않게 한다
        print(f"HQ heartbeat 전송 실패: {exc}")

# heartbeat("start", {"runId": run_id, "stage": "generating"})
# heartbeat("fail", {"runId": run_id, "errorCode": "IG_401", "message": "게시 API 401"})
```

## GitHub Actions 안에서

```yaml
- name: HQ 게시 완료 보고
  if: success()
  env:
    HQ_URL: ${{ vars.HQ_URL }}
    HQ_PROJECT_KEY: factbokai
    HQ_HEARTBEAT_SECRET: ${{ secrets.HQ_HEARTBEAT_SECRET }}
  run: node scripts/hq-heartbeat.mjs complete "${{ github.run_id }}"
```

CLI 테스트 도구: `node scripts/heartbeat-send.mjs start run-001` (HQ_URL·HQ_PROJECT_KEY·HQ_HEARTBEAT_SECRET 환경 변수 필요).

**원칙:** HQ 전송 실패가 본 자동화(업로드·게시)를 실패시키면 안 된다. 항상 try/except로 감싼다.
