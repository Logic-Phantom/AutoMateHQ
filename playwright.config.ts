import { defineConfig } from '@playwright/test';

// 핵심 사용자 흐름 E2E. 샘플 모드(로컬 전용 D1)에서 실행하므로 외부 API를 호출하지 않는다.
// 최초 1회: npx playwright install chromium
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  use: { baseURL: 'http://localhost:5173', locale: 'ko-KR', timezoneId: 'Asia/Seoul' },
  webServer: {
    command: 'node scripts/dev.mjs demo',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
