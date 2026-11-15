/**
 * Web Crypto 기반 보안 유틸리티. Cloudflare Workers와 Node(테스트) 모두에서 동작한다.
 * - 비밀 값 암호화: AES-256-GCM, 키 버전 접두어를 붙여 키 교체를 지원한다.
 * - 서명 검증: HMAC-SHA256 + 상수 시간 비교.
 */
type Bytes = Uint8Array<ArrayBuffer>;
const enc = new TextEncoder();
const dec = new TextDecoder();

export function bytesToHex(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = '';
  for (const b of arr) out += b.toString(16).padStart(2, '0');
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function base64ToBytes(b64: string): Bytes {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function base64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

export async function sha256Hex(input: string): Promise<string> {
  return bytesToHex(await crypto.subtle.digest('SHA-256', enc.encode(input)));
}

/** 길이가 달라도 비교 시간을 일정하게 유지하는 문자열 비교. */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

export async function hmacSha256Hex(secret: string, message: string | Bytes): Promise<string> {
  const key = await hmacKey(secret);
  const data = typeof message === 'string' ? enc.encode(message) : message;
  return bytesToHex(await crypto.subtle.sign('HMAC', key, data));
}

/** GitHub `X-Hub-Signature-256: sha256=<hex>` 검증. 반드시 raw body로 검증한다. */
export async function verifyGithubSignature(secret: string, rawBody: Bytes, header: string | null): Promise<boolean> {
  if (!header || !header.startsWith('sha256=')) return false;
  const expected = 'sha256=' + (await hmacSha256Hex(secret, rawBody));
  return timingSafeEqual(expected, header);
}

// ---------------- AES-GCM ----------------
export class CryptoConfigError extends Error {}

async function aesKey(b64: string): Promise<CryptoKey> {
  const raw = base64ToBytes(b64);
  if (raw.length !== 32) throw new CryptoConfigError('HQ_ENCRYPTION_KEY는 base64 32바이트여야 합니다.');
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export interface KeyRing {
  current: string | undefined;
  previous?: string | undefined;
}

/** 출력 형식: v{버전}.{iv base64}.{암호문 base64}. 현재 키 = v2, 이전 키 = v1 로 보지 않고 키 자체를 순서대로 시도한다. */
export async function encryptSecret(ring: KeyRing, plaintext: string, aad = 'hq'): Promise<string> {
  if (!ring.current) throw new CryptoConfigError('HQ_ENCRYPTION_KEY가 설정되지 않았습니다.');
  const key = await aesKey(ring.current);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(aad) },
    key,
    enc.encode(plaintext),
  );
  return `v1.${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(ct))}`;
}

export async function decryptSecret(ring: KeyRing, payload: string, aad = 'hq'): Promise<string> {
  const [ver, ivB64, ctB64] = payload.split('.');
  if (ver !== 'v1' || !ivB64 || !ctB64) throw new CryptoConfigError('알 수 없는 암호문 형식입니다.');
  const keys = [ring.current, ring.previous].filter((k): k is string => Boolean(k));
  if (keys.length === 0) throw new CryptoConfigError('HQ_ENCRYPTION_KEY가 설정되지 않았습니다.');
  for (const k of keys) {
    try {
      const pt = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: base64ToBytes(ivB64), additionalData: enc.encode(aad) },
        await aesKey(k),
        base64ToBytes(ctB64),
      );
      return dec.decode(pt);
    } catch (err) {
      if (err instanceof CryptoConfigError) throw err;
    }
  }
  throw new CryptoConfigError('복호화 실패: 암호화 키를 확인하세요.');
}

// ---------------- 비밀번호(PBKDF2) ----------------
/** Workers의 PBKDF2 반복 횟수 상한(100,000)에 맞춘다. */
export const PBKDF2_ITERATIONS = 100_000;

export async function hashPassword(password: string, saltB64?: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const salt = saltB64 ? base64ToBytes(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return `pbkdf2-sha256$${iterations}$${bytesToBase64(salt)}$${bytesToBase64(new Uint8Array(bits))}`;
}

export async function verifyPassword(password: string, stored: string | undefined): Promise<boolean> {
  if (!stored) return false;
  const [algo, iterStr, salt, hash] = stored.split('$');
  if (algo !== 'pbkdf2-sha256' || !iterStr || !salt || !hash) return false;
  const iterations = Number(iterStr);
  if (!Number.isInteger(iterations) || iterations < 10_000 || iterations > PBKDF2_ITERATIONS) return false;
  const candidate = await hashPassword(password, salt, iterations);
  return timingSafeEqual(candidate, stored);
}
