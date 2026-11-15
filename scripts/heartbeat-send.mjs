// Heartbeat 서명 요청 예제/도구. 자동화 프로그램 연결 전 테스트용.
// 사용: HQ_URL=https://… HQ_PROJECT_KEY=my-project HQ_HEARTBEAT_SECRET=hqhb_… node scripts/heartbeat-send.mjs start run-001
//       type: start | complete | fail
import { createHmac } from 'node:crypto';

const [type = 'start', runId = `manual-${Date.now()}`] = process.argv.slice(2);
const url = process.env.HQ_URL;
const projectKey = process.env.HQ_PROJECT_KEY;
const secret = process.env.HQ_HEARTBEAT_SECRET;
if (!url || !projectKey || !secret) {
  console.error('HQ_URL, HQ_PROJECT_KEY, HQ_HEARTBEAT_SECRET 환경 변수가 필요합니다.');
  process.exit(1);
}
if (!['start', 'complete', 'fail'].includes(type)) {
  console.error('type은 start | complete | fail');
  process.exit(1);
}

const body = JSON.stringify({
  projectKey,
  runId,
  source: 'heartbeat-cli',
  stage: type === 'start' ? 'started' : type === 'complete' ? 'done' : 'failed',
  message: `CLI ${type}`,
  ...(type === 'fail' ? { errorCode: 'CLI_TEST' } : {}),
});
const ts = Math.floor(Date.now() / 1000);
const signature = 'sha256=' + createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');

const res = await fetch(`${url.replace(/\/$/, '')}/api/v1/heartbeat/${type}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-HQ-Project': projectKey, 'X-HQ-Timestamp': String(ts), 'X-HQ-Signature': signature },
  body,
});
console.info(res.status, await res.text());
