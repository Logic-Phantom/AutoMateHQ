# 로컬 실행

요구: Node.js 22.13 이상(24 권장), npm.

```bash
npm install
```

npm 11에서 설치 스크립트가 막혀 있으면 한 번 허용한다(wrangler·vite 실행에 필요).

```bash
npm install-scripts approve esbuild workerd
```

## 샘플(데모) 모드 — 계정 없이 바로 보기

```bash
npm run dev:demo
```

- http://localhost:5173 , 비밀번호 `demo` (로컬 접속 + 샘플 모드에서만 허용)
- 별도 로컬 D1(`automatehq-demo`)에 14일치 샘플 데이터가 들어간다. 다시 채우기: `npm run demo:reset`
- 외부 API를 전혀 호출하지 않는다.

## 운영 모드 로컬 실행

```bash
npm run secret:password
```

출력된 해시와 `npm run secret:keygen` 결과를 `.dev.vars`(Git 제외)에 넣는다. 형식은 `.dev.vars.example` 참고.

```bash
npm run dev
```

## 테스트

```bash
npm test
```

```bash
npx playwright install chromium
```

```bash
npm run test:e2e
```

| 명령 | 내용 |
|---|---|
| `npm run typecheck` | 프런트·Worker·테스트 TypeScript strict 검사 |
| `npm run lint` | ESLint |
| `npm test` | Vitest(단위·통합·컴포넌트). 실제 migration을 Node 내장 SQLite에 적용 |
| `npm run test:e2e` | Playwright(샘플 모드 서버 자동 기동) |
