// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CHART, SegmentedBar, RunStrip } from './charts';
import { Badge, Loading, StatusBadge } from './ui';

describe('상태 표시 컴포넌트', () => {
  it('상태는 색만이 아니라 라벨로도 표시된다', () => {
    render(<StatusBadge status="ATTENTION" />);
    expect(screen.getByText('확인 필요')).toBeInTheDocument();
  });

  it('알 수 없는 상태는 확인 불가로 표시한다(정상으로 보이지 않음)', () => {
    render(<StatusBadge status="SOMETHING" />);
    expect(screen.getByText('확인 불가')).toBeInTheDocument();
  });

  it('분할 막대는 접근 가능한 이름에 각 부분의 값을 담는다', () => {
    render(
      <SegmentedBar
        label="상태 분포"
        parts={[
          { key: 'a', label: '정상', value: 3, color: '#0ca30c' },
          { key: 'b', label: '실패', value: 0, color: '#d03b3b' },
        ]}
      />,
    );
    expect(screen.getByRole('img', { name: /정상 3, 실패 0/ })).toBeInTheDocument();
  });

  it('실행 스트립은 날짜마다 툴팁을 가진다', () => {
    const { container } = render(<RunStrip name="p" cells={[{ date: '2026-11-15', success: 1, failure: 1, other: 0 }]} />);
    expect(container.querySelector('[title*="실패 후 복구"]')).not.toBeNull();
  });

  it('Badge는 내용을 렌더링한다', () => {
    render(<Badge tone="ok">연결됨</Badge>);
    expect(screen.getByText('연결됨')).toBeInTheDocument();
  });

  it('로딩은 스피너 대신 skeleton 줄과 화면 낭독용 라벨로 표시한다', () => {
    const { container } = render(<Loading label="실행 이력 불러오는 중" rows={2} />);
    expect(screen.getByRole('status')).toHaveTextContent('실행 이력 불러오는 중');
    expect(container.querySelectorAll('[aria-hidden].animate-pulse')).toHaveLength(2);
    expect(container.querySelector('.animate-spin')).toBeNull();
  });

  it('차트 색은 디자인 토큰(CSS 변수)만 참조한다', () => {
    for (const value of Object.values(CHART)) expect(value).toMatch(/^var\(--color-[a-z0-9-]+\)$/);
  });
});
