import { expect, test } from '@playwright/test';

test.describe('핵심 사용자 흐름(샘플 모드)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('비밀번호').fill('demo');
    await page.getByRole('button', { name: '로그인' }).click();
    await expect(page.getByRole('heading', { name: '운영 현황' })).toBeVisible();
  });

  test('대시보드에 샘플 데이터 표시와 KPI·차트가 보인다', async ({ page }) => {
    await expect(page.getByText('샘플 데이터 — 데모 모드입니다.')).toBeVisible();
    await expect(page.getByText('활성 프로젝트')).toBeVisible();
    await expect(page.getByRole('img', { name: /최근 14일 일별 실행 결과/ })).toBeVisible();
  });

  test('실패한 실행의 재실행은 확인 모달을 거친다(샘플 모드는 실제 호출 없음)', async ({ page }) => {
    await page.getByRole('link', { name: '실행 이력' }).first().click();
    await page.getByRole('button', { name: '재실행' }).first().click();
    await expect(page.getByRole('heading', { name: '실패한 워크플로 재실행' })).toBeVisible();
    await page.getByRole('button', { name: '재실행 승인' }).click();
    await expect(page.getByText(/샘플 모드에서는 재실행을 하지 않습니다/)).toBeVisible();
  });

  test('알림 화면에서 카카오 보고서 미리보기는 200자 이하 메시지로 렌더링된다', async ({ page }) => {
    await page.getByRole('link', { name: '알림' }).first().click();
    await page.getByRole('button', { name: '보고서 미리보기' }).click();
    const counters = page.getByText(/\/200자$/);
    await expect(counters.first()).toBeVisible();
    for (const t of await counters.allTextContents()) expect(Number(t.split('/')[0])).toBeLessThanOrEqual(200);
  });
});
