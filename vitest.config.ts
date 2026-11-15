import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    globals: true,
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts', 'src/**/*.test.tsx'],
    // 프런트엔드 테스트 파일은 첫 줄의 `// @vitest-environment jsdom` 주석으로 jsdom을 쓴다.
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
  },
});
