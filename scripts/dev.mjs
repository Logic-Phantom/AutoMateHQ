// 로컬 개발 실행: wrangler dev(8787, Worker+D1) + vite(5173, 프런트엔드)를 함께 띄운다.
// 사용: npm run dev        → 운영 모드(로컬 D1 `automatehq`, .dev.vars 필요)
//       npm run dev:demo   → 샘플 모드(별도 로컬 D1 `automatehq-demo`, 샘플 데이터·외부 호출 없음)
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';

const mode = process.argv[2] === 'demo' ? 'demo' : 'live';
const isWin = process.platform === 'win32';
const npx = isWin ? 'npx.cmd' : 'npx';
const run = (args) => spawnSync(npx, args, { stdio: 'inherit', shell: isWin });

const varsFile = mode === 'demo' ? '.dev.vars.demo' : '.dev.vars';
if (!existsSync(varsFile)) {
  const key = Buffer.from(webcrypto.getRandomValues(new Uint8Array(32))).toString('base64');
  const lines = [
    '# 로컬 개발용 비밀 값(자동 생성, Git에 커밋되지 않음)',
    `HQ_ENCRYPTION_KEY=${key}`,
    mode === 'demo' ? '# 샘플 모드: 로컬 접속에서는 비밀번호 demo 로 로그인' : '# ADMIN_PASSWORD_HASH=  ← npm run secret:password 결과를 넣으세요',
    '# GITHUB_WEBHOOK_SECRET=',
    '# KAKAO_REST_API_KEY=',
    '# KAKAO_CLIENT_SECRET=',
    '',
  ];
  writeFileSync(varsFile, lines.join('\n'));
  console.info(`${varsFile} 파일을 만들었습니다.`);
}

if (mode === 'demo') {
  run(['wrangler', 'd1', 'migrations', 'apply', 'automatehq-demo', '--local', '--env', 'demo']);
  if (!existsSync('.wrangler/.demo-seeded')) {
    spawnSync(process.execPath, ['scripts/demo-reset.mjs'], { stdio: 'inherit' });
  }
} else {
  run(['wrangler', 'd1', 'migrations', 'apply', 'automatehq', '--local']);
}

const workerArgs = ['wrangler', 'dev', '--port', '8787', ...(mode === 'demo' ? ['--env', 'demo'] : []), '--var', 'PUBLIC_BASE_URL:http://localhost:5173', '--var', 'ALLOWED_ORIGINS:http://localhost:5173'];
const children = [
  spawn(npx, workerArgs, { stdio: 'inherit', shell: isWin }),
  spawn(npx, ['vite'], { stdio: 'inherit', shell: isWin }),
];
console.info(`\n▶ AI Automation HQ (${mode === 'demo' ? '샘플 모드' : '운영 모드'}) → http://localhost:5173\n`);
const stop = () => children.forEach((c) => c.kill());
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
