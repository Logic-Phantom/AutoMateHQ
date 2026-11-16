# 카카오톡 ‘나와의 채팅’ 보고서 설정

HQ는 **카카오톡 메시지 REST API의 ‘나에게 기본 템플릿으로 메시지 보내기’** 만 사용한다. 친구에게 보내지 않으며, 읽음 여부는 알 수 없다.
(공식 문서 확인일 2026-11-15: `POST https://kapi.kakao.com/v2/api/talk/memo/default/send`, 동의 항목 `talk_message`, 성공 시 `result_code: 0`)

> 앱 아이콘은 Kakao Developers > 앱 > 일반 > 앱 아이콘에서 `docs/assets/icon.webp`를 PNG로 변환해 등록하면 된다.

## 현재 설정(2026-11-15)

앱 **AI Automation HQ (ID 1651324)** 생성 완료: 카카오 로그인 ON · Redirect URI `https://automatehq.dlacoaud96.workers.dev/api/integrations/kakao/callback`, `http://localhost:5173/api/integrations/kakao/callback` · `talk_message` 선택 동의 · 웹 도메인 `https://automatehq.dlacoaud96.workers.dev` · Client Secret ON(기본값).
남은 일: REST API 키·클라이언트 시크릿을 Cloudflare Secret에 등록 → 대시보드 알림 화면에서 연결.

> 새 콘솔에서는 Redirect URI와 Client Secret이 **앱 > 플랫폼 키 > REST API 키 수정** 화면에 있다.

## 1. 앱 준비

**권장: HQ 전용 앱을 새로 만든다.** CHIPLY·청약 브리핑처럼 기존 브리핑 앱과 같은 앱을 공유하면, 한쪽에서 ‘연결 끊기(unlink)’를 할 때 다른 프로젝트의 토큰도 함께 무효가 될 수 있다. (HQ의 연결 해제는 unlink가 아닌 로컬 삭제/로그아웃만 쓴다.)

1. https://developers.kakao.com → 내 애플리케이션 → 애플리케이션 추가(이름 예: AI Automation HQ)
2. **앱 키 > REST API 키** 복사 → `KAKAO_REST_API_KEY`
3. **제품 설정 > 카카오 로그인 > 활성화 ON**
4. **카카오 로그인 > Redirect URI** 등록: `{PUBLIC_BASE_URL}/api/integrations/kakao/callback`
   - 로컬 테스트용: `http://localhost:5173/api/integrations/kakao/callback`
   - 대시보드 알림 화면에 실제로 쓰는 값이 표시된다(정확히 같아야 함).
5. **카카오 로그인 > 동의항목 > 카카오톡 메시지 전송(`talk_message`)** 을 ‘선택 동의’ 이상으로 설정
6. **앱 설정 > 플랫폼 > Web > 사이트 도메인**에 `PUBLIC_BASE_URL` 도메인 등록
   - 메시지 버튼 링크(`/reports/날짜`)는 등록된 도메인만 열린다.
7. **카카오 로그인 > 보안 > Client Secret**: 사용하면 코드 생성 후 ‘활성화’ → `KAKAO_CLIENT_SECRET`
   - REST API 키는 Client Secret이 기본 ON일 수 있다. 켜져 있으면 반드시 secret도 등록해야 토큰 발급·갱신이 된다.

## 2. HQ에 등록

```bash
npx wrangler secret put KAKAO_REST_API_KEY
```

```bash
npx wrangler secret put KAKAO_CLIENT_SECRET
```

## 3. 연결과 테스트

1. 대시보드 → **알림** → “카카오 로그인 연결” → 카카오 동의 화면에서 메시지 전송 동의
2. 돌아오면 “연결됨” 표시 → **테스트 메시지 보내기** → 카톡 ‘나와의 채팅’ 확인
3. **보고서 미리보기**로 12:00 정기 보고서 메시지(최대 3개, 각 200자 이하) 확인

## 4. 토큰과 재연결

| 항목 | 값(공식 문서) | HQ 동작 |
|---|---|---|
| access token | REST API 6시간 | 만료 5분 전부터 발송 직전에 갱신 |
| refresh token | 2개월, 만료 1개월 전부터 갱신 응답에 새 값 포함 | 응답에 있을 때만 교체 저장, 만료 예정일 화면 표시 |
| 갱신 실패(invalid_grant, KOE322 등) | – | 상태 ‘재연결 필요’ + 전역 incident, 보고서 발송 중단 |
| 발송 403(동의 철회) | – | 동일하게 ‘재연결 필요’ |

**2개월 안에 한 번은 12:00 정기 보고서가 정상 발송되어야** 리프레시 토큰이 자동 연장된다(매일 발송되면 문제없음). 재연결 필요가 뜨면 알림 화면에서 다시 연결한다.

## 5. 메시지 형식

카카오 텍스트 템플릿은 **text 최대 200자**라 원래 기획처럼 긴 보고서 한 통은 보낼 수 없다. HQ는:

1. 요약: 날짜·전체 수·🟢🔴🟡 건수·실패/확인 필요 프로젝트명
2. 상세: 실패·확인 필요 사유(넘치면 “외 N건은 HQ에서 확인”)
3. 정상 요약 + `🧭 자동 점검 요약`(Claude Routine 결과가 실제로 있으면 `🧠 AI 분석`)

각 메시지의 버튼 “HQ에서 보기”가 대시보드 전체 보고서(`/reports/YYYY-MM-DD`)로 연결된다.

## 7시 알림 최종 체크리스트

- [ ] Worker 배포 + `PUBLIC_BASE_URL` 설정 + `/api/health/ready` 200
- [ ] `KAKAO_REST_API_KEY`(+ 필요 시 `KAKAO_CLIENT_SECRET`) 등록
- [ ] Redirect URI·Web 도메인·`talk_message` 동의 항목 설정
- [ ] 알림 화면에서 연결 → 테스트 메시지 수신 확인
- [ ] “12:00 정기 보고서” 켜짐
- [ ] 다음 날 12:00 이후 수신, 대시보드 ‘오늘 12:00 카카오 보고서’에 실제 발송 시각 기록 확인
