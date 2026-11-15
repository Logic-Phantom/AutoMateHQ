// HQ_ENCRYPTION_KEY(AES-256-GCM) 생성. 출력값을 `wrangler secret put HQ_ENCRYPTION_KEY` 에 붙여 넣는다.
// 사용: npm run secret:keygen
import { webcrypto } from 'node:crypto';

const key = webcrypto.getRandomValues(new Uint8Array(32));
process.stdout.write(Buffer.from(key).toString('base64') + '\n');
