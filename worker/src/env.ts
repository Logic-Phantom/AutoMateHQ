import type { Db } from './lib/db';

/** Worker 바인딩·환경 변수. 비밀 값은 모두 `wrangler secret put` 으로만 주입한다. */
export interface Env {
  DB: Db;
  ASSETS?: { fetch(request: Request): Promise<Response> };
  APP_MODE: 'live' | 'demo';
  APP_TIMEZONE?: string;
  /** 대시보드 공개 주소(예: https://automatehq.example.workers.dev). 카카오 Redirect URI·보고서 링크에 쓴다. */
  PUBLIC_BASE_URL?: string;
  /** 쉼표로 구분한 허용 Origin. 비어 있으면 PUBLIC_BASE_URL의 origin만 허용한다. */
  ALLOWED_ORIGINS?: string;
  /** GitHub Actions 예약 워크플로가 스케줄러를 깨울 때 허용할 저장소(owner/name). 비우면 외부 트리거 비활성. */
  SCHEDULER_OIDC_REPOSITORY?: string;

  // ---- secrets ----
  /** `npm run secret:password` 로 만든 PBKDF2 해시. 평문 비밀번호는 어디에도 저장하지 않는다. */
  ADMIN_PASSWORD_HASH?: string;
  /** base64 32바이트 AES-GCM 키. `npm run secret:keygen` */
  HQ_ENCRYPTION_KEY?: string;
  /** 키 교체 시 이전 키(복호화 전용). */
  HQ_ENCRYPTION_KEY_PREVIOUS?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  KAKAO_REST_API_KEY?: string;
  KAKAO_CLIENT_SECRET?: string;
}

/** 테스트에서 외부 HTTP 호출을 바꿔 끼울 수 있게 fetch를 주입한다. */
export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface AppDeps {
  fetch: FetchFn;
  now: () => Date;
}

export const defaultDeps: AppDeps = {
  fetch: (input, init) => fetch(input, init),
  now: () => new Date(),
};
