// 관리자 비밀번호 → PBKDF2-SHA256 해시(ADMIN_PASSWORD_HASH). 평문 비밀번호는 어디에도 저장하지 않는다.
// 사용: npm run secret:password   (프롬프트에 비밀번호 입력, 화면에 표시되지 않음)
//       또는 파이프:  echo -n 'pw' | node scripts/hash-password.mjs --stdin
import { webcrypto } from 'node:crypto';
import { createInterface } from 'node:readline';

const ITERATIONS = 100_000; // Cloudflare Workers PBKDF2 상한

async function hash(password) {
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const key = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await webcrypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, key, 256);
  return `pbkdf2-sha256$${ITERATIONS}$${Buffer.from(salt).toString('base64')}$${Buffer.from(bits).toString('base64')}`;
}

async function readHidden(prompt) {
  if (process.argv.includes('--stdin') || !process.stdin.isTTY) {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl._writeToOutput = (s) => {
    if (s.includes(prompt)) process.stdout.write(prompt);
  };
  const answer = await new Promise((resolve) => rl.question(prompt, resolve));
  rl.close();
  process.stdout.write('\n');
  return answer;
}

const pw = await readHidden('관리자 비밀번호(12자 이상 권장): ');
if (!pw || pw.length < 10) {
  console.error('비밀번호는 10자 이상이어야 합니다.');
  process.exit(1);
}
process.stdout.write((await hash(pw)) + '\n');
console.error('↑ 이 값을 `npx wrangler secret put ADMIN_PASSWORD_HASH` 에 붙여 넣으세요(로컬은 .dev.vars).');
