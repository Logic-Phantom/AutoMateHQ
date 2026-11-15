import { KAKAO_TEXT_LIMIT } from '../../../../shared/constants';
import type { FetchFn } from '../../env';

/**
 * 카카오 REST API (공식 문서 2026-11-15 확인)
 * - 인가: GET  https://kauth.kakao.com/oauth/authorize (response_type=code, scope=talk_message, state)
 * - 토큰: POST https://kauth.kakao.com/oauth/token (authorization_code / refresh_token, client_secret 활성 시 포함)
 *   · REST API access token 6시간, refresh token 2개월
 *   · refresh 응답의 refresh_token 은 만료 1개월 미만일 때만 포함된다 → 있을 때만 교체 저장
 * - 나에게 보내기: POST https://kapi.kakao.com/v2/api/talk/memo/default/send, template_object, 성공 시 result_code 0
 * - 텍스트 템플릿 text 최대 200자, 버튼 최대 2개
 * 친구에게 보내기는 구현하지 않는다. 읽음 여부는 알 수 없다.
 */
export const KAKAO_AUTHORIZE_URL = 'https://kauth.kakao.com/oauth/authorize';
export const KAKAO_TOKEN_URL = 'https://kauth.kakao.com/oauth/token';
export const KAKAO_MEMO_URL = 'https://kapi.kakao.com/v2/api/talk/memo/default/send';
export const KAKAO_LOGOUT_URL = 'https://kapi.kakao.com/v1/user/logout';

/** 사람이 다시 카카오 로그인을 해야 하는 상태(리프레시 토큰 만료·동의 철회·앱 키 오류) */
export class KakaoReauthRequired extends Error {
  constructor(public readonly code: string) {
    super(`카카오 재연결 필요(${code})`);
  }
}
export class KakaoApiError extends Error {
  constructor(
    public readonly httpStatus: number | null,
    public readonly code: string,
  ) {
    super(`카카오 API 오류: HTTP ${httpStatus ?? '-'} ${code}`);
  }
}

export interface KakaoTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  scope?: string;
}

export interface KakaoAppConfig {
  restApiKey: string;
  clientSecret?: string;
  redirectUri: string;
}

const REAUTH_CODES = new Set(['invalid_grant', 'invalid_client', 'unauthorized_client', 'KOE319', 'KOE320', 'KOE322', 'KOE010']);

async function errorCode(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error_code?: string; error?: string; code?: number | string; msg?: string };
    return String(body.error_code ?? body.error ?? body.code ?? 'unknown');
  } catch {
    return 'unknown';
  }
}

export function buildAuthorizeUrl(cfg: KakaoAppConfig, state: string): string {
  const qs = new URLSearchParams({
    client_id: cfg.restApiKey,
    redirect_uri: cfg.redirectUri,
    response_type: 'code',
    scope: 'talk_message',
    state,
  });
  return `${KAKAO_AUTHORIZE_URL}?${qs}`;
}

export class KakaoClient {
  constructor(
    private readonly cfg: KakaoAppConfig,
    private readonly fetchFn: FetchFn,
  ) {}

  private async tokenRequest(form: Record<string, string>): Promise<KakaoTokenResponse> {
    const body = new URLSearchParams({ client_id: this.cfg.restApiKey, ...form });
    if (this.cfg.clientSecret) body.set('client_secret', this.cfg.clientSecret);
    let res: Response;
    try {
      res = await this.fetchFn(KAKAO_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
        body: body.toString(),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new KakaoApiError(null, 'NETWORK_ERROR');
    }
    if (!res.ok) {
      // 응답 본문(토큰이 섞일 수 있음)은 저장하지 않고 오류 코드만 본다
      const code = await errorCode(res);
      if (REAUTH_CODES.has(code) || res.status === 401) throw new KakaoReauthRequired(code);
      throw new KakaoApiError(res.status, code);
    }
    return (await res.json()) as KakaoTokenResponse;
  }

  exchangeCode(code: string): Promise<KakaoTokenResponse> {
    return this.tokenRequest({ grant_type: 'authorization_code', redirect_uri: this.cfg.redirectUri, code });
  }

  refresh(refreshToken: string): Promise<KakaoTokenResponse> {
    return this.tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  /** 성공 시 HTTP 200 + result_code 0. 401은 호출자가 토큰 갱신 후 1회 재시도한다. */
  async sendMemo(accessToken: string, text: string, linkUrl: string, buttonTitle = 'HQ에서 보기'): Promise<{ status: number; code: string }> {
    const template = buildTextTemplate(text, linkUrl, buttonTitle);
    let res: Response;
    try {
      res = await this.fetchFn(KAKAO_MEMO_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
        },
        body: new URLSearchParams({ template_object: JSON.stringify(template) }).toString(),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return { status: 0, code: 'NETWORK_ERROR' };
    }
    if (res.status === 200) {
      const body = (await res.json().catch(() => ({}))) as { result_code?: number };
      return { status: 200, code: body.result_code === 0 ? '0' : String(body.result_code ?? 'unknown') };
    }
    return { status: res.status, code: await errorCode(res) };
  }

  /** 이 토큰만 만료시킨다. 같은 카카오 앱을 쓰는 다른 프로젝트의 동의(unlink)는 건드리지 않는다. */
  async logout(accessToken: string): Promise<boolean> {
    try {
      const res = await this.fetchFn(KAKAO_LOGOUT_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(10_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}

export function buildTextTemplate(text: string, linkUrl: string, buttonTitle: string) {
  if ([...text].length > KAKAO_TEXT_LIMIT) throw new Error(`카카오 텍스트 템플릿 한도 초과: ${[...text].length}자`);
  return {
    object_type: 'text',
    text,
    link: { web_url: linkUrl, mobile_web_url: linkUrl },
    button_title: buttonTitle.slice(0, 14),
  };
}
